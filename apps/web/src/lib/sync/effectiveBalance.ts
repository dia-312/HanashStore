import type { OutboxRow } from '../../db'
import { invoiceTotals, lineTotal } from '../billing'
import type {
  CancelPayload,
  InvoiceCreatePayload,
  PaymentCreatePayload,
  PaymentVoidPayload,
} from './commands'

type PendingCommand = Pick<OutboxRow, 'type' | 'payload' | 'status'>

/** What the invoice of a `invoice.create` command comes to, worked out the way the server will. */
export function createdInvoiceTotal(payload: InvoiceCreatePayload): number {
  return invoiceTotals(
    payload.lines.map((l) => lineTotal(l.qty, l.unit_price)),
    payload.discount,
  ).total
}

/**
 * The balance the rep should see: what the server last said for each customer, plus the commands
 * still waiting, in the order they were made (SPEC section 7: "the device caches the last server
 * value and adjusts it locally for pending commands"). It reads the outbox only, never the
 * optimistic invoice rows, so nothing is counted twice, and a rejected command stops counting by
 * itself.
 *
 * Returns only the customers a pending command touches.
 */
export function pendingBalances(
  base: ReadonlyMap<string, number>,
  commands: readonly PendingCommand[],
): Map<string, number> {
  const current = new Map<string, number>()
  const add = (customerId: string, delta: number) => {
    const balance = current.get(customerId) ?? base.get(customerId)
    if (balance !== undefined) current.set(customerId, balance + delta)
  }
  for (const command of commands) {
    if (command.status !== 'pending') continue
    if (command.type === 'invoice.create') {
      const p = command.payload as InvoiceCreatePayload
      add(p.customer_id, createdInvoiceTotal(p) - (p.payment?.amount ?? 0))
    } else if (command.type === 'invoice.cancel') {
      const p = command.payload as CancelPayload
      // The invoice stops counting; its payment only comes back out if the rep voids it.
      add(p.customer_id, -p.total + (p.void_payment ? p.payment_amount : 0))
    } else if (command.type === 'payment.create') {
      const p = command.payload as PaymentCreatePayload
      add(p.customer_id, -p.amount)
    } else if (command.type === 'payment.void') {
      const p = command.payload as PaymentVoidPayload
      add(p.customer_id, p.amount) // the money goes back onto what he owes
    }
  }
  return current
}

/** Balance of one customer with the waiting commands counted. */
export function effectiveBalance(
  customerId: string,
  serverBalance: number,
  commands: readonly PendingCommand[],
): number {
  return (
    pendingBalances(new Map([[customerId, serverBalance]]), commands).get(customerId) ??
    serverBalance
  )
}
