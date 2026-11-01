import { db, type CommandError, type OutboxRow } from '../../db'
import { takeNumber } from '../counters'
import { uuid7 } from '../uuid7'
import {
  SCHEMA_VERSION,
  type CommandType,
  type CustomerPayload,
  type InvoiceCreatePayload,
  type PaymentCreatePayload,
  type ReturnCreatePayload,
} from './commands'

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

/** The rep gave up on it. Its effect on the shown stock and balance disappears with it, and so do
 * the optimistic rows it made on this device (a sale that never reached the server). */
export async function discard(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.outbox,
      db.invoices,
      db.invoice_lines,
      db.payments,
      db.customers,
      db.returns,
      db.return_lines,
    ],
    async () => {
      const command = await db.outbox.where('id').equals(id).first()
      if (command?.type === 'invoice.create') {
        const p = command.payload as InvoiceCreatePayload
        // Only rows still unconfirmed (change_seq 0): never touch what the server has.
        await db.invoice_lines.bulkDelete(p.lines.map((l) => l.line_id))
        if (p.payment)
          await db.payments
            .where('id')
            .equals(p.payment.payment_id)
            .and((x) => x.change_seq === 0)
            .delete()
        await db.invoices
          .where('id')
          .equals(p.invoice_id)
          .and((x) => x.change_seq === 0)
          .delete()
      } else if (command?.type === 'payment.create') {
        const p = command.payload as PaymentCreatePayload
        await db.payments
          .where('id')
          .equals(p.payment_id)
          .and((x) => x.change_seq === 0)
          .delete()
      } else if (command?.type === 'return.create') {
        const p = command.payload as ReturnCreatePayload
        await db.return_lines
          .where('return_id')
          .equals(p.return_id)
          .and((x) => x.change_seq === 0)
          .delete()
        await db.returns
          .where('id')
          .equals(p.return_id)
          .and((x) => x.change_seq === 0)
          .delete()
      } else if (command?.type === 'customer.upsert') {
        const p = command.payload as CustomerPayload
        await db.customers
          .where('id')
          .equals(p.customer_id)
          .and((x) => x.change_seq === 0)
          .delete()
      }
      await db.outbox.where('id').equals(id).delete()
    },
  )
}

/**
 * Try a rejected command again. It gets a new command id: the server keeps the answer for the old
 * id and would repeat the rejection forever. The movement ids inside stay the same, which is safe
 * because a rejected command left nothing behind.
 */
export async function retry(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.outbox, db.invoices, db.payments, db.returns, db.meta],
    async () => {
      const old = await db.outbox.where('id').equals(id).first()
      if (!old || old.status !== 'rejected') return
      let payload = old.payload
      if (old.type === 'invoice.create' && old.error?.code === 'DUPLICATE_NUMBER') {
        payload = await withFreshNumber(payload as InvoiceCreatePayload, old.error.details.number)
      } else if (old.type === 'payment.create' && old.error?.code === 'DUPLICATE_NUMBER') {
        const number = await takeNumber('REC')
        payload = { ...(payload as PaymentCreatePayload), number }
        await db.payments.update((payload as PaymentCreatePayload).payment_id, { number })
      } else if (old.type === 'return.create' && old.error?.code === 'DUPLICATE_NUMBER') {
        const number = await takeNumber('RET')
        payload = { ...(payload as ReturnCreatePayload), number }
        await db.returns.update((payload as ReturnCreatePayload).return_id, { number })
      }
      await db.outbox.where('id').equals(id).delete()
      await db.outbox.add({
        id: uuid7(),
        type: old.type,
        schema_version: old.schema_version,
        payload,
        created_at: new Date().toISOString(),
        status: 'pending',
      })
    },
  )
}

/** The server already had this document number (should never happen): take the next one, on the
 * command and on the optimistic rows the rep sees. */
async function withFreshNumber(
  payload: InvoiceCreatePayload,
  duplicate: unknown,
): Promise<InvoiceCreatePayload> {
  const next = { ...payload }
  if (duplicate === payload.number) {
    next.number = await takeNumber('INV')
    await db.invoices.update(payload.invoice_id, { number: next.number })
  } else if (payload.payment && duplicate === payload.payment.number) {
    const number = await takeNumber('REC')
    next.payment = { ...payload.payment, number }
    await db.payments.update(payload.payment.payment_id, { number })
  }
  return next
}

/** When the oldest waiting command was made, for the "pending for over 24 hours" warning. */
export async function oldestPendingAt(): Promise<number | null> {
  const first = (await pendingCommands())[0]
  return first ? Date.parse(first.created_at) : null
}
