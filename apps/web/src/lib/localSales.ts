import {
  db,
  type DbCustomer,
  type DbInvoice,
  type DbInvoiceLine,
  type DbPayment,
  type DbReturn,
  type DbReturnLine,
  type OutboxRow,
} from '../db'
import { remainingOnInvoice } from './billing'
import { normalizeArabic } from './normalize'
import type {
  CancelPayload,
  InvoiceCreatePayload,
  MarkDeliveredPayload,
  PaymentCreatePayload,
  PaymentVoidPayload,
  RefundCreatePayload,
  ReturnCreatePayload,
} from './sync/commands'
import { pendingBalances } from './sync/effectiveBalance'

/** Everything the customer and invoice screens read, taken from this device in one go. The
 * builders below are plain functions of it, so they are easy to test. */
export interface SalesSnapshot {
  customers: DbCustomer[]
  invoices: DbInvoice[]
  lines: DbInvoiceLine[]
  payments: DbPayment[]
  returns: DbReturn[]
  returnLines: DbReturnLine[]
  /** Pending and rejected commands, oldest first. */
  outbox: OutboxRow[]
}

export async function loadSalesSnapshot(): Promise<SalesSnapshot> {
  const [customers, invoices, lines, payments, returns, returnLines, outbox] = await Promise.all([
    db.customers.toArray(),
    db.invoices.toArray(),
    db.invoice_lines.toArray(),
    db.payments.toArray(),
    db.returns.toArray(),
    db.return_lines.toArray(),
    db.outbox.orderBy('seq').toArray(),
  ])
  return { customers, invoices, lines, payments, returns, returnLines, outbox }
}

const collator = new Intl.Collator('ar')

/** The balance each customer shows: the server's number plus the commands still waiting. */
export function effectiveBalances(s: SalesSnapshot): Map<string, number> {
  const base = new Map(s.customers.map((c) => [c.id, c.balance]))
  const changed = pendingBalances(base, s.outbox)
  return new Map([...base].map(([id, balance]) => [id, changed.get(id) ?? balance]))
}

export type CustomerSort = 'name' | 'balance' | 'lastInvoice'

export interface CustomerItem {
  id: string
  name: string
  shop_name: string | null
  phone: string | null
  area: string | null
  is_active: boolean
  balance: number
  last_invoice_at: string | null
  /** Made on this device and not yet received by the server. */
  unsent: boolean
}

export interface CustomerFilter {
  q?: string
  sort?: CustomerSort
  includeInactive?: boolean
}

export function buildCustomerList(s: SalesSnapshot, filter: CustomerFilter = {}): CustomerItem[] {
  const balances = effectiveBalances(s)
  const lastInvoice = new Map<string, string>()
  for (const inv of s.invoices) {
    if (inv.status === 'cancelled') continue
    const seen = lastInvoice.get(inv.customer_id)
    if (!seen || inv.issued_at > seen) lastInvoice.set(inv.customer_id, inv.issued_at)
  }
  const tokens = normalizeArabic(filter.q ?? '')
    .split(' ')
    .filter(Boolean)
  const items: CustomerItem[] = []
  for (const c of s.customers) {
    if (!c.is_active && !filter.includeInactive) continue
    if (!tokens.every((t) => c.search_text.includes(t))) continue
    items.push({
      id: c.id,
      name: c.name,
      shop_name: c.shop_name,
      phone: c.phone,
      area: c.area,
      is_active: c.is_active,
      balance: balances.get(c.id) ?? c.balance,
      last_invoice_at: lastInvoice.get(c.id) ?? null,
      unsent: c.change_seq === 0,
    })
  }
  const byName = (a: CustomerItem, b: CustomerItem) => collator.compare(a.name, b.name)
  switch (filter.sort ?? 'name') {
    case 'balance':
      return items.sort((a, b) => b.balance - a.balance || byName(a, b))
    case 'lastInvoice':
      return items.sort(
        (a, b) => (b.last_invoice_at ?? '').localeCompare(a.last_invoice_at ?? '') || byName(a, b),
      )
    default:
      return items.sort(byName)
  }
}

export type SendState = 'synced' | 'pending' | 'rejected'

export interface InvoiceItem {
  id: string
  number: string
  customer_id: string
  customer_name: string
  total: number
  paid: number
  remaining: number
  issued_at: string
  delivered: boolean
  status: 'confirmed' | 'cancelled'
  sendState: SendState
}

export interface InvoiceFilter {
  customerId?: string
  delivered?: boolean
  status?: 'confirmed' | 'cancelled'
  /** ISO dates, inclusive. */
  from?: string
  to?: string
}

export interface Effects {
  cancelled: Map<string, { voidPayment: boolean }>
  delivered: Map<string, string>
  creation: Map<string, SendState>
  /** Payments the rep has voided and the server has not heard yet: id to reason. */
  voided: Map<string, string>
  /** Standalone payments made on this device: how far they have got. */
  paymentCreation: Map<string, SendState>
  /** Returns made on this device: how far they have got. */
  returnCreation: Map<string, SendState>
}

/** What waiting commands say about each invoice: cancelled, delivered, and not yet confirmed. */
export function saleEffects(s: SalesSnapshot): Effects {
  const out: Effects = {
    cancelled: new Map(),
    delivered: new Map(),
    creation: new Map(),
    voided: new Map(),
    paymentCreation: new Map(),
    returnCreation: new Map(),
  }
  for (const c of s.outbox) {
    const state: SendState = c.status === 'rejected' ? 'rejected' : 'pending'
    if (c.type === 'invoice.create') {
      out.creation.set((c.payload as InvoiceCreatePayload).invoice_id, state)
    } else if (c.type === 'return.create') {
      out.returnCreation.set((c.payload as ReturnCreatePayload).return_id, state)
    } else if (c.type === 'payment.create') {
      out.paymentCreation.set((c.payload as PaymentCreatePayload).payment_id, state)
    } else if (c.type === 'refund.create') {
      out.paymentCreation.set((c.payload as RefundCreatePayload).refund_id, state)
    } else if (c.status === 'pending' && c.type === 'payment.void') {
      const p = c.payload as PaymentVoidPayload
      out.voided.set(p.payment_id, p.reason)
    } else if (c.status === 'pending' && c.type === 'invoice.cancel') {
      const p = c.payload as CancelPayload
      out.cancelled.set(p.invoice_id, { voidPayment: p.void_payment })
    } else if (c.status === 'pending' && c.type === 'invoice.mark_delivered') {
      const p = c.payload as MarkDeliveredPayload
      out.delivered.set(p.invoice_id, p.delivered_at)
    }
  }
  return out
}

/** Is this payment out of the books, counting what is still waiting to be sent? */
export function paymentIsVoided(e: Effects, p: DbPayment): boolean {
  if (p.status === 'voided' || e.voided.has(p.id)) return true
  return p.invoice_id !== null && (e.cancelled.get(p.invoice_id)?.voidPayment ?? false)
}

/** A payment or invoice made here that the server refused: it never counted anywhere. */
export function paymentWasRefused(e: Effects, p: DbPayment): boolean {
  if (e.paymentCreation.get(p.id) === 'rejected') return true
  return p.invoice_id !== null && e.creation.get(p.invoice_id) === 'rejected'
}

/** A return the server refused: it never counted anywhere. */
export function returnWasRefused(e: Effects, r: DbReturn): boolean {
  return e.returnCreation.get(r.id) === 'rejected'
}

/** For each invoice line: units already taken back and the credit already given, leaving out any
 * return the server refused (those never counted). Waiting returns count: they are real here. */
export function returnedByLine(s: SalesSnapshot): Map<string, { qty: number; amount: number }> {
  const e = saleEffects(s)
  const refused = new Set(s.returns.filter((r) => returnWasRefused(e, r)).map((r) => r.id))
  const out = new Map<string, { qty: number; amount: number }>()
  for (const line of s.returnLines) {
    if (refused.has(line.return_id)) continue
    const seen = out.get(line.invoice_line_id) ?? { qty: 0, amount: 0 }
    out.set(line.invoice_line_id, { qty: seen.qty + line.qty, amount: seen.amount + line.amount })
  }
  return out
}

export interface ReturnableLine {
  line: DbInvoiceLine
  returned: number
  creditedSoFar: number
  remaining: number
}

/** The lines of an invoice with how much of each can still come back. */
export function returnableLines(s: SalesSnapshot, invoiceId: string): ReturnableLine[] {
  const done = returnedByLine(s)
  return s.lines
    .filter((l) => l.invoice_id === invoiceId)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((line) => {
      const seen = done.get(line.id) ?? { qty: 0, amount: 0 }
      return {
        line,
        returned: seen.qty,
        creditedSoFar: seen.amount,
        remaining: line.qty - seen.qty,
      }
    })
}

function paidOn(s: SalesSnapshot, e: Effects, invoiceId: string): number {
  return s.payments
    .filter((p) => p.invoice_id === invoiceId && !paymentIsVoided(e, p))
    .reduce((sum, p) => sum + p.amount, 0)
}

export function buildInvoiceList(s: SalesSnapshot, filter: InvoiceFilter = {}): InvoiceItem[] {
  const e = saleEffects(s)
  const names = new Map(s.customers.map((c) => [c.id, c.name]))
  const items: InvoiceItem[] = []
  for (const inv of s.invoices) {
    if (filter.customerId && inv.customer_id !== filter.customerId) continue
    const status = e.cancelled.has(inv.id) ? 'cancelled' : inv.status
    if (filter.status && status !== filter.status) continue
    const delivered = inv.delivered_at !== null || e.delivered.has(inv.id)
    if (filter.delivered !== undefined && delivered !== filter.delivered) continue
    if (filter.from && inv.issued_at.slice(0, 10) < filter.from) continue
    if (filter.to && inv.issued_at.slice(0, 10) > filter.to) continue
    const paid = paidOn(s, e, inv.id)
    items.push({
      id: inv.id,
      number: inv.number,
      customer_id: inv.customer_id,
      customer_name: names.get(inv.customer_id) ?? '',
      total: inv.total,
      paid,
      remaining: remainingOnInvoice(inv.total, paid),
      issued_at: inv.issued_at,
      delivered,
      status,
      sendState: e.creation.get(inv.id) ?? 'synced',
    })
  }
  return items.sort(
    (a, b) => b.issued_at.localeCompare(a.issued_at) || b.number.localeCompare(a.number),
  )
}

export interface InvoiceDetail extends InvoiceItem {
  subtotal: number
  discount: number
  note: string | null
  cancel_reason: string | null
  delivered_at: string | null
  lines: DbInvoiceLine[]
  payments: DbPayment[]
  /** Reason from the server when the sale was refused (sync screen has the full text). */
  rejectedCode: string | null
  /** The rep may still cancel it: confirmed, nothing waiting to cancel it. */
  canCancel: boolean
  hasActivePayment: boolean
  /** A cancellation is waiting to be sent: the server's PDF would not show it yet. */
  cancelPending: boolean
  /** Returns taken from this invoice, oldest first. Refused ones are left out. */
  returns: ReturnItem[]
  /** Something can still come back: confirmed, not being cancelled, units left on a line. */
  canReturn: boolean
}

export interface ReturnItem {
  id: string
  number: string
  invoice_id: string
  invoice_number: string
  total: number
  issued_at: string
  reason: string | null
  sendState: SendState
  lines: {
    product_name: string
    variant_label: string
    qty: number
    disposition: DbReturnLine['disposition']
    amount: number
  }[]
}

/** The returns of a customer (or of one invoice), newest first, leaving out the refused. */
export function buildReturnList(
  s: SalesSnapshot,
  filter: { customerId?: string; invoiceId?: string },
): ReturnItem[] {
  const e = saleEffects(s)
  const numbers = new Map(s.invoices.map((i) => [i.id, i.number]))
  const lineById = new Map(s.lines.map((l) => [l.id, l]))
  const items: ReturnItem[] = []
  for (const r of s.returns) {
    if (filter.customerId && r.customer_id !== filter.customerId) continue
    if (filter.invoiceId && r.invoice_id !== filter.invoiceId) continue
    if (returnWasRefused(e, r)) continue
    items.push({
      id: r.id,
      number: r.number,
      invoice_id: r.invoice_id,
      invoice_number: numbers.get(r.invoice_id) ?? '',
      total: r.total,
      issued_at: r.issued_at,
      reason: r.reason,
      sendState: e.returnCreation.get(r.id) ?? 'synced',
      lines: s.returnLines
        .filter((l) => l.return_id === r.id)
        .map((l) => {
          const sold = lineById.get(l.invoice_line_id)
          return {
            product_name: sold?.product_name ?? '',
            variant_label: sold?.variant_label ?? '',
            qty: l.qty,
            disposition: l.disposition,
            amount: l.amount,
          }
        }),
    })
  }
  return items.sort(
    (a, b) => b.issued_at.localeCompare(a.issued_at) || b.number.localeCompare(a.number),
  )
}

export function buildInvoiceDetail(s: SalesSnapshot, invoiceId: string): InvoiceDetail | null {
  const inv = s.invoices.find((i) => i.id === invoiceId)
  if (!inv) return null
  const e = saleEffects(s)
  const [item] = buildInvoiceList({ ...s, invoices: [inv] })
  if (!item) return null
  const rejected = s.outbox.find(
    (c) =>
      c.status === 'rejected' &&
      c.type === 'invoice.create' &&
      (c.payload as InvoiceCreatePayload).invoice_id === invoiceId,
  )
  // A payment voided here, with the server not yet told, already shows as voided.
  const payments = s.payments
    .filter((p) => p.invoice_id === invoiceId)
    .map((p): DbPayment => (paymentIsVoided(e, p) ? { ...p, status: 'voided' } : p))
  const returns = buildReturnList(s, { invoiceId })
  return {
    ...item,
    subtotal: inv.subtotal,
    discount: inv.discount,
    note: inv.note,
    cancel_reason: e.cancelled.has(inv.id)
      ? ((
          s.outbox.find(
            (c) =>
              c.type === 'invoice.cancel' && (c.payload as CancelPayload).invoice_id === inv.id,
          )?.payload as CancelPayload | undefined
        )?.reason ?? null)
      : inv.cancel_reason,
    delivered_at: inv.delivered_at ?? e.delivered.get(inv.id) ?? null,
    lines: s.lines
      .filter((l) => l.invoice_id === invoiceId)
      .sort((a, b) => a.sort_order - b.sort_order),
    payments,
    rejectedCode: rejected?.error?.code ?? null,
    // An invoice with returns can't be cancelled (SPEC section 7): cancel it first or return.
    canCancel: item.status === 'confirmed' && item.sendState !== 'rejected' && returns.length === 0,
    hasActivePayment: payments.some((p) => p.status === 'active'),
    cancelPending: e.cancelled.has(inv.id),
    returns,
    canReturn:
      item.status === 'confirmed' &&
      item.sendState !== 'rejected' &&
      returnableLines(s, invoiceId).some((l) => l.remaining > 0),
  }
}

export interface CustomerProfile extends CustomerItem {
  address: string | null
  notes: string | null
  opening_balance: number
  invoices: InvoiceItem[]
  payments: PaymentItem[]
  returns: ReturnItem[]
}

export interface PaymentItem {
  id: string
  number: string
  /** Money received, or money handed back to the customer. */
  kind: 'payment' | 'refund'
  amount: number
  method: DbPayment['method']
  paid_at: string
  note: string | null
  status: 'active' | 'voided'
  void_reason: string | null
  /** The invoice it was taken with; null for a payment on its own. */
  invoice_number: string | null
  sendState: SendState
  /** The rep may void it: counted, made here or already on the server, nothing waiting on it. */
  canVoid: boolean
  /** A void is waiting to be sent. */
  voidPending: boolean
}

/** A customer's payments, newest first, with what is still waiting counted in. */
export function buildPaymentList(s: SalesSnapshot, customerId: string): PaymentItem[] {
  const e = saleEffects(s)
  const numbers = new Map(s.invoices.map((i) => [i.id, i.number]))
  const items: PaymentItem[] = []
  for (const p of s.payments) {
    if (p.customer_id !== customerId) continue
    const voided = paymentIsVoided(e, p)
    const sendState: SendState = p.invoice_id
      ? (e.creation.get(p.invoice_id) ?? 'synced')
      : (e.paymentCreation.get(p.id) ?? 'synced')
    items.push({
      id: p.id,
      number: p.number,
      kind: p.kind ?? 'payment',
      amount: p.amount,
      method: p.method,
      paid_at: p.paid_at,
      note: p.note,
      status: voided ? 'voided' : 'active',
      void_reason: p.void_reason ?? e.voided.get(p.id) ?? null,
      invoice_number: p.invoice_id ? (numbers.get(p.invoice_id) ?? null) : null,
      sendState,
      canVoid: !voided && sendState !== 'rejected',
      voidPending: e.voided.has(p.id),
    })
  }
  return items.sort(
    (a, b) => b.paid_at.localeCompare(a.paid_at) || b.number.localeCompare(a.number),
  )
}

export function buildCustomerProfile(s: SalesSnapshot, customerId: string): CustomerProfile | null {
  const customer = s.customers.find((c) => c.id === customerId)
  if (!customer) return null
  const [item] = buildCustomerList({ ...s, customers: [customer] }, { includeInactive: true })
  if (!item) return null
  return {
    ...item,
    address: customer.address,
    notes: customer.notes,
    opening_balance: customer.opening_balance,
    invoices: buildInvoiceList(s, { customerId }),
    payments: buildPaymentList(s, customerId),
    returns: buildReturnList(s, { customerId }),
  }
}
