import { db, getMeta, type OutboxRow } from '../../db'
import { ApiError, api } from '../api'
import type { CommandResult, PushResponse } from './commands'
import { markRejected, pendingCommands } from './outbox'

export const BATCH = 50

type Send = (deviceId: string, commands: OutboxRow[]) => Promise<PushResponse>

const send: Send = (deviceId, commands) =>
  api<PushResponse>('/sync/push', {
    method: 'POST',
    body: {
      device_id: deviceId,
      commands: commands.map((c) => ({
        id: c.id,
        type: c.type,
        schema_version: c.schema_version,
        created_at: c.created_at,
        payload: c.payload,
      })),
    },
  })

/**
 * What the server said about one batch, written in a single transaction: an applied command leaves
 * the outbox at the same moment its new stock quantities land, so the screen never flickers back to
 * the old number (and, for a sale, the customer's balance the server worked out). A rejected
 * command stays, marked, for the sync screen.
 */
async function recordResults(results: CommandResult[]): Promise<void> {
  await db.transaction('rw', [db.outbox, db.variants, db.customers], async () => {
    for (const result of results) {
      if (result.status === 'applied') {
        const { customer_id: customerId, customer_balance: balance } = result.data ?? {}
        if (customerId !== undefined && balance !== undefined) {
          await db.customers.where('id').equals(customerId).modify({ balance })
        }
        for (const state of result.data?.variants ?? []) {
          const variant = await db.variants.get(state.id)
          if (variant && state.change_seq >= variant.change_seq) {
            await db.variants.put({
              ...variant,
              stock_qty: state.stock_qty,
              change_seq: state.change_seq,
            })
          }
        }
        await db.outbox.where('id').equals(result.id).delete()
      } else if (result.error) {
        await db.outbox
          .where('id')
          .equals(result.id)
          .modify({ status: 'rejected', error: result.error })
      }
    }
  })
}

/** A request the server cannot read (400, 413, 422): it will never be accepted as it is. */
const isUnreadable = (e: unknown) =>
  e instanceof ApiError && [400, 413, 422].includes(e.status) && e.code !== 'UNAUTHENTICATED'

/** A crash on the server (500). It may be a moment's trouble, so it is tried again, not judged at once. */
const isCrash = (e: unknown) => e instanceof ApiError && e.status === 500

/** How many times in a row one command alone may crash the server before it is set aside. */
export const CRASH_LIMIT = 3

/**
 * One command the server cannot take must not stop all the ones behind it for ever. It is shown on
 * the sync screen as refused (the rep can try it again or give it up) and the others go through.
 */
async function quarantine(command: OutboxRow, e: unknown): Promise<void> {
  const status = e instanceof ApiError ? e.status : 0
  await markRejected(command.id, {
    code: status === 500 ? 'SERVER_ERROR' : 'REQUEST_REFUSED',
    message: e instanceof Error ? e.message : 'The server could not process this command',
    details: { status },
  })
}

/** Sends waiting commands, oldest first, 50 per request. Returns how many were handled. */
export async function pushPending(sendBatch: Send = send): Promise<number> {
  const deviceId = (await getMeta<{ device: { id: string } }>('identity'))?.device.id
  if (!deviceId) return 0
  let handled = 0
  for (;;) {
    const batch = (await pendingCommands()).slice(0, BATCH)
    if (batch.length === 0) return handled
    let response: PushResponse
    try {
      response = await sendBatch(deviceId, batch)
    } catch (e) {
      if (!isUnreadable(e) && !isCrash(e)) throw e
      // Find the command that does it by sending them one at a time, in order. Those before it go
      // through; it is set aside when the server will never read it, or has crashed on it again and
      // again; otherwise (a first crash) everything from it on waits for the next run, in order.
      for (const command of batch) {
        try {
          const one = await sendBatch(deviceId, [command])
          await recordResults(one.results)
          handled += one.results.length
        } catch (inner) {
          if (isUnreadable(inner)) {
            await quarantine(command, inner)
            handled += 1
            continue
          }
          if (!isCrash(inner)) throw inner
          const failures = (command.failures ?? 0) + 1
          if (failures >= CRASH_LIMIT) {
            await quarantine(command, inner)
            handled += 1
            continue
          }
          await db.outbox.where('id').equals(command.id).modify({ failures })
          throw inner
        }
      }
      continue
    }
    await recordResults(response.results)
    handled += response.results.length
    // The server answered for none of them: stop rather than send the same batch forever.
    if (response.results.length === 0) return handled
  }
}
