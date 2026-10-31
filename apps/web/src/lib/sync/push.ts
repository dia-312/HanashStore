import { db, getMeta, type OutboxRow } from '../../db'
import { api } from '../api'
import type { CommandResult, PushResponse } from './commands'
import { pendingCommands } from './outbox'

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

/** Sends waiting commands, oldest first, 50 per request. Returns how many were handled. */
export async function pushPending(sendBatch: Send = send): Promise<number> {
  const deviceId = (await getMeta<{ device: { id: string } }>('identity'))?.device.id
  if (!deviceId) return 0
  let handled = 0
  for (;;) {
    const batch = (await pendingCommands()).slice(0, BATCH)
    if (batch.length === 0) return handled
    const response = await sendBatch(deviceId, batch)
    await recordResults(response.results)
    handled += response.results.length
    // The server answered for none of them: stop rather than send the same batch forever.
    if (response.results.length === 0) return handled
  }
}
