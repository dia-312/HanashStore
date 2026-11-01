import labels from '../../../../shared/documents_labels.json'
import { dayToDisplay, formatDate, formatDateTime, hebronDay } from './date'
import {
  buildInvoiceDetail,
  effectiveBalances,
  paymentIsVoided,
  paymentWasRefused,
  saleEffects,
  type SalesSnapshot,
} from './localSales'
import { formatMoney } from './money'
import type { Business } from './settings'

// The invoice and the statement as plain text-ready models: every amount and date is already
// text, so a component only lays it out. Built by the same rules as the server's
// apps/api/app/services/documents.py and tested against the same fixtures
// (shared/documents_cases.json); the layout is described once in shared/documents.css.

export const LABELS = labels

export interface DocBusiness {
  name: string
  phone: string
  footer: string
  logo_url: string | null
}

export const docBusiness = (b: Business): DocBusiness => ({
  name: b.business_name,
  phone: b.phone,
  footer: b.invoice_footer,
  logo_url: b.logo_url,
})

interface DocCustomer {
  name: string
  shop_name: string | null
  phone: string | null
}

export interface InvoiceDoc {
  business: DocBusiness
  number: string
  issued_at: string
  cancelled: boolean
  cancel_reason: string | null
  customer: DocCustomer
  lines: {
    n: number
    product: string
    variant: string
    qty: number
    unit_price: string
    line_total: string
  }[]
  totals: {
    subtotal: string
    discount: string | null
    total: string
    paid: string
    remaining: string
  }
  note: string | null
}

/** The invoice as the rep sees it on this device (waiting cancellations included). */
export function invoiceDocument(
  s: SalesSnapshot,
  invoiceId: string,
  business: Business,
): InvoiceDoc | null {
  const invoice = buildInvoiceDetail(s, invoiceId)
  if (!invoice) return null
  const customer = s.customers.find((c) => c.id === invoice.customer_id)
  if (!customer) return null
  return {
    business: docBusiness(business),
    number: invoice.number,
    issued_at: formatDateTime(invoice.issued_at),
    cancelled: invoice.status === 'cancelled',
    cancel_reason: invoice.cancel_reason,
    customer: { name: customer.name, shop_name: customer.shop_name, phone: customer.phone },
    lines: invoice.lines.map((line, i) => ({
      n: i + 1,
      product: line.product_name,
      variant: line.variant_label,
      qty: line.qty,
      unit_price: formatMoney(line.unit_price),
      line_total: formatMoney(line.line_total),
    })),
    totals: {
      subtotal: formatMoney(invoice.subtotal),
      discount: invoice.discount > 0 ? formatMoney(invoice.discount) : null,
      total: formatMoney(invoice.total),
      paid: formatMoney(invoice.paid),
      remaining: formatMoney(invoice.remaining),
    },
    note: invoice.note,
  }
}

export interface StatementEntry {
  kind: 'opening' | 'invoice' | 'payment'
  /** ISO timestamp; the opening row has none (it is dated by the period). */
  at: string
  ref: string
  debit: number
  credit: number
  /** Shown but never counted: a cancelled invoice, a voided payment. */
  off: 'cancelled' | 'voided' | null
  balance: number
}

export interface Statement {
  rows: StatementEntry[]
  totalDebit: number
  totalCredit: number
  closing: number
}

/** `yyyy-MM-dd` three months back (the statement's default start), like the server. */
export function defaultPeriod(today: string): { from: string; to: string } {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number]
  let month = m - 3
  let year = y
  if (month < 1) {
    month += 12
    year -= 1
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return { from: `${year}-${pad(month)}-${pad(Math.min(d, 28))}`, to: today }
}

/**
 * Opening balance, invoices (debit) and payments (credit) of a period with a running balance.
 *
 * The server counts forward from the customer's opening balance. The device may not hold every old
 * invoice, so it counts backwards instead: the balance he has now, minus what happened since the
 * period began. Both give the same number wherever the device has the rows of the period.
 */
export function buildStatement(
  s: SalesSnapshot,
  customerId: string,
  from: string,
  to: string,
  includeOff = false,
): Statement | null {
  const customer = s.customers.find((c) => c.id === customerId)
  if (!customer) return null
  const now = effectiveBalances(s).get(customerId) ?? customer.balance
  const e = saleEffects(s)
  const cancelled = (invoiceId: string) => e.cancelled.has(invoiceId)

  const entries: (StatementEntry & { day: string })[] = []
  for (const inv of s.invoices) {
    if (inv.customer_id !== customerId) continue
    if (e.creation.get(inv.id) === 'rejected') continue // the server refused it: it never counted
    const off = inv.status === 'cancelled' || cancelled(inv.id) ? 'cancelled' : null
    entries.push({
      kind: 'invoice',
      at: inv.issued_at,
      ref: inv.number,
      debit: inv.total,
      credit: 0,
      off,
      balance: 0,
      day: hebronDay(inv.issued_at),
    })
  }
  for (const p of s.payments) {
    if (p.customer_id !== customerId) continue
    if (paymentWasRefused(e, p)) continue
    const off = paymentIsVoided(e, p) ? 'voided' : null
    entries.push({
      kind: 'payment',
      at: p.paid_at,
      ref: p.number,
      debit: 0,
      credit: p.amount,
      off,
      balance: 0,
      day: hebronDay(p.paid_at),
    })
  }

  const sinceStart = entries
    .filter((x) => x.off === null && x.day >= from)
    .reduce((sum, x) => sum + x.debit - x.credit, 0)
  let balance = now - sinceStart

  const rows: StatementEntry[] = [
    { kind: 'opening', at: '', ref: '', debit: 0, credit: 0, off: null, balance },
  ]
  const inPeriod = entries
    .filter((x) => x.day >= from && x.day <= to && (x.off === null || includeOff))
    .sort(
      (a, b) =>
        a.at.localeCompare(b.at) ||
        (a.kind === b.kind ? 0 : a.kind === 'invoice' ? -1 : 1) ||
        a.ref.localeCompare(b.ref),
    )
  let totalDebit = 0
  let totalCredit = 0
  for (const x of inPeriod) {
    if (x.off === null) {
      balance += x.debit - x.credit
      totalDebit += x.debit
      totalCredit += x.credit
    }
    rows.push({ ...x, balance })
  }
  return { rows, totalDebit, totalCredit, closing: balance }
}

export interface StatementDoc {
  business: DocBusiness
  customer: DocCustomer
  period: { from: string; to: string }
  rows: {
    date: string
    label: string
    number: string | null
    debit: string | null
    credit: string | null
    balance: string
    css: string
  }[]
  totals: { debit: string; credit: string; closing: string }
}

export function statementDocument(
  s: SalesSnapshot,
  customerId: string,
  from: string,
  to: string,
  includeOff: boolean,
  business: Business,
): StatementDoc | null {
  const customer = s.customers.find((c) => c.id === customerId)
  const data = buildStatement(s, customerId, from, to, includeOff)
  if (!customer || !data) return null
  const L = labels.statement
  return {
    business: docBusiness(business),
    customer: { name: customer.name, shop_name: customer.shop_name, phone: customer.phone },
    period: { from: dayToDisplay(from), to: dayToDisplay(to) },
    rows: data.rows.map((r) => ({
      date: r.kind === 'opening' ? dayToDisplay(from) : formatDate(r.at),
      label:
        r.kind === 'opening'
          ? L.opening
          : r.kind === 'invoice'
            ? L.invoice + (r.off ? ` ${L.cancelled}` : '')
            : r.off
              ? L.voided
              : L.payment,
      number: r.ref || null,
      debit: r.debit ? formatMoney(r.debit) : null,
      credit: r.credit ? formatMoney(r.credit) : null,
      balance: formatMoney(r.balance),
      css: r.kind === 'opening' ? 'opening' : r.off ? 'off' : '',
    })),
    totals: {
      debit: formatMoney(data.totalDebit),
      credit: formatMoney(data.totalCredit),
      closing: formatMoney(data.closing),
    },
  }
}
