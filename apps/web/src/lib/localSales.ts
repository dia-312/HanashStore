import {
  db,
  type DbCustomer,
  type DbInvoice,
  type DbInvoiceLine,
  type DbPayment,
  type OutboxRow,
} from '../db'
import { remainingOnInvoice } from './billing'
import { normalizeArabic } from './normalize'
import type { CancelPayload, InvoiceCreatePayload, MarkDeliveredPayload } from './sync/commands'
import { pendingBalances } from './sync/effectiveBalance'

/** Everything the customer and invoice screens read, taken from this device in one go. The
 * builders below are plain functions of it, so they are easy to test. */
export interface SalesSnapshot {
  customers: DbCustomer[]
  invoices: DbInvoice[]
  lines: DbInvoiceLine[]
  payments: DbPayment[]
  /** Pending and rejected commands, oldest first. */
  outbox: OutboxRow[]
}

export async function loadSalesSnapshot(): Promise<SalesSnapshot> {
  const [customers, invoices, lines, payments, outbox] = await Promise.all([
    db.customers.toArray(),
    db.invoices.toArray(),
    db.invoice_lines.toArray(),
    db.payments.toArray(),
    db.outbox.orderBy('seq').toArray(),
  ])
  return { customers, invoices, lines, payments, outbox }
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
}

/** What waiting commands say about each invoice: cancelled, delivered, and not yet confirmed. */
export function saleEffects(s: SalesSnapshot): Effects {
  const out: Effects = { cancelled: new Map(), delivered: new Map(), creation: new Map() }
  for (const c of s.outbox) {
    const state: SendState = c.status === 'rejected' ? 'rejected' : 'pending'
    if (c.type === 'invoice.create') {
      out.creation.set((c.payload as InvoiceCreatePayload).invoice_id, state)
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

function paidOn(s: SalesSnapshot, e: Effects, invoiceId: string): number {
  const voided = e.cancelled.get(invoiceId)?.voidPayment ?? false
  return s.payments
    .filter((p) => p.invoice_id === invoiceId && p.status === 'active' && !voided)
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
  const payments = s.payments.filter((p) => p.invoice_id === invoiceId)
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
    canCancel: item.status === 'confirmed' && item.sendState !== 'rejected',
    hasActivePayment: payments.some((p) => p.status === 'active') && !e.cancelled.has(inv.id),
  }
}

export interface CustomerProfile extends CustomerItem {
  address: string | null
  notes: string | null
  opening_balance: number
  invoices: InvoiceItem[]
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
  }
}
