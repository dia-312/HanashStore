import { db, type CommandError, type OutboxRow } from '../../db'
import { uuid7 } from '../uuid7'
import { SCHEMA_VERSION, type CommandType } from './commands'

/** Every write the rep makes in the field becomes a command here first (SPEC section 8). */
export async function enqueue(type: CommandType, payload: unknown): Promise<OutboxRow> {
  const row: OutboxRow = {
    id: uuid7(),
    type,
    schema_version: SCHEMA_VERSION,
    payload,
    created_at: new Date().toISOString(),
    status: 'pending',
  }
  row.seq = await db.outbox.add(row)
  return row
}

/** In the order they were made. */
export const pendingCommands = () => db.outbox.where('status').equals('pending').sortBy('seq')

export const rejectedCommands = () => db.outbox.where('status').equals('rejected').sortBy('seq')

export const allCommands = () => db.outbox.orderBy('seq').toArray()

export const pendingCount = () => db.outbox.where('status').equals('pending').count()

export async function markRejected(id: string, error: CommandError): Promise<void> {
  await db.outbox.where('id').equals(id).modify({ status: 'rejected', error })
}

/** The rep gave up on it. Its effect on the shown stock disappears with it. */
export async function discard(id: string): Promise<void> {
  await db.outbox.where('id').equals(id).delete()
}

/**
 * Try a rejected command again. It gets a new command id: the server keeps the answer for the old
 * id and would repeat the rejection forever. The movement ids inside stay the same, which is safe
 * because a rejected command left nothing behind.
 */
export async function retry(id: string): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    const old = await db.outbox.where('id').equals(id).first()
    if (!old || old.status !== 'rejected') return
    await db.outbox.where('id').equals(id).delete()
    await db.outbox.add({
      id: uuid7(),
      type: old.type,
      schema_version: old.schema_version,
      payload: old.payload,
      created_at: new Date().toISOString(),
      status: 'pending',
    })
  })
}

/** When the oldest waiting command was made, for the "pending for over 24 hours" warning. */
export async function oldestPendingAt(): Promise<number | null> {
  const first = (await pendingCommands())[0]
  return first ? Date.parse(first.created_at) : null
}
