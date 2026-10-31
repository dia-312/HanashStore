import { describe, expect, it } from 'vitest'
import cases from '../../../../shared/documents_cases.json'
import type { DbCustomer, DbInvoice, DbInvoiceLine, DbPayment, OutboxRow } from '../db'
import { buildStatement, defaultPeriod, invoiceDocument, statementDocument } from './documents'
import type { SalesSnapshot } from './localSales'
import type { Business } from './settings'

// The same scenario the server tests use (shared/documents_cases.json): raw rows in, the document
// model out. The device must produce exactly what the server does.

const CUSTOMER_ID = cases.customer.id
const business: Business = {
  business_name: cases.settings.business_name,
  phone: cases.settings.phone,
  invoice_footer: cases.settings.invoice_footer,
  logo_url: null,
  hide_out_of_stock_in_presentation: true,
}

const fixtureSnapshot = (): SalesSnapshot => {
  const invoices: DbInvoice[] = []
  const lines: DbInvoiceLine[] = []
  const payments: DbPayment[] = []
  for (const inv of cases.invoices) {
    invoices.push({
      id: inv.id,
      number: inv.number,
      customer_id: CUSTOMER_ID,
      status: inv.status as DbInvoice['status'],
      subtotal: inv.subtotal,
      discount: inv.discount,
      total: inv.total,
      note: inv.note,
      issued_at: inv.issued_at,
      delivered_at: null,
      cancelled_at: null,
      cancel_reason: inv.cancel_reason,
      change_seq: 5,
    })
    inv.lines.forEach((line, i) =>
      lines.push({
        id: `${inv.id}-${i}`,
        invoice_id: inv.id,
        variant_id: 'v',
        sort_order: i,
        change_seq: 5,
        ...line,
      }),
    )
    for (const p of inv.payments) {
      payments.push({
        id: p.id,
        number: p.number,
        customer_id: CUSTOMER_ID,
        invoice_id: inv.id,
        method: p.method as DbPayment['method'],
        amount: p.amount,
        paid_at: p.paid_at,
        note: null,
        status: p.status as DbPayment['status'],
        voided_at: null,
        void_reason: null,
        change_seq: 5,
      })
    }
  }
  for (const p of cases.standalone_payments) {
    payments.push({
      id: p.id,
      number: p.number,
      customer_id: CUSTOMER_ID,
      invoice_id: null,
      method: p.method as DbPayment['method'],
      amount: p.amount,
      paid_at: p.paid_at,
      note: null,
      status: p.status as DbPayment['status'],
      voided_at: null,
      void_reason: null,
      change_seq: 5,
    })
  }
  const c = cases.customer
  const customer: DbCustomer = {
    id: c.id,
    name: c.name,
    shop_name: c.shop_name,
    phone: c.phone,
    area: null,
    address: null,
    notes: null,
    opening_balance: c.opening_balance,
    search_text: c.name,
    is_active: true,
    // What the server reports now: opening 50 + invoices 100 + 45 - payments 30 + 45 + 20.
    balance: 10000,
    change_seq: 5,
  }
  return { customers: [customer], invoices, lines, payments, outbox: [] }
}

describe('invoice document (same model as the server)', () => {
  const expected = cases.expected_invoices as Record<string, unknown>
  it.each(Object.keys(expected))('%s', (number) => {
    const s = fixtureSnapshot()
    const id = s.invoices.find((i) => i.number === number)!.id
    expect(invoiceDocument(s, id, business)).toEqual(expected[number])
  })

  it('a missing invoice has no document', () => {
    expect(invoiceDocument(fixtureSnapshot(), 'nope', business)).toBeNull()
  })

  it('a cancellation still waiting to be sent already stamps the invoice and voids its payment', () => {
    const s = fixtureSnapshot()
    const inv = s.invoices.find((i) => i.number === 'INV-000002')!
    const cancel: OutboxRow = {
      id: 'c',
      type: 'invoice.cancel',
      schema_version: 1,
      created_at: '2026-11-04T00:00:00Z',
      status: 'pending',
      payload: {
        invoice_id: inv.id,
        cancelled_at: '2026-11-04T00:00:00Z',
        reason: 'خطأ',
        void_payment: true,
        customer_id: CUSTOMER_ID,
        total: 4500,
        payment_amount: 4500,
        lines: [],
      },
    }
    const doc = invoiceDocument({ ...s, outbox: [cancel] }, inv.id, business)
    expect(doc).toMatchObject({ cancelled: true, cancel_reason: 'خطأ' })
    expect(doc?.totals).toMatchObject({ paid: '₪ 0.00', remaining: '₪ 45.00' })
  })

  it('the invoice carries paid and remaining but no overall customer balance', () => {
    const s = fixtureSnapshot()
    const doc = invoiceDocument(s, s.invoices[0]!.id, business)!
    expect(JSON.stringify(doc)).not.toContain('balance')
  })
})

describe('statement (same rows as the server)', () => {
  it.each(cases.statements)('$name', (c) => {
    const doc = statementDocument(
      fixtureSnapshot(),
      CUSTOMER_ID,
      c.from,
      c.to,
      c.include_off,
      business,
    )
    expect(doc).toEqual(c.expected)
  })

  it('counts backwards from the balance he has now, so a period older than the device keeps still starts right', () => {
    const s = fixtureSnapshot()
    // The device never received the July invoice and its payment (older than what it keeps).
    const trimmed: SalesSnapshot = {
      ...s,
      invoices: s.invoices.filter((i) => i.number !== 'INV-000001'),
      lines: s.lines.filter((l) => !l.invoice_id.endsWith('000001')),
      payments: s.payments.filter((p) => p.number !== 'REC-000001'),
    }
    const November = buildStatement(trimmed, CUSTOMER_ID, '2026-11-01', '2026-11-30')!
    expect(November.rows[0]?.balance).toBe(12000) // the carried balance is still right
    expect(November.closing).toBe(10000)
  })

  it('the closing balance is always the balance he has now when the period reaches today', () => {
    const data = buildStatement(fixtureSnapshot(), CUSTOMER_ID, '2026-01-01', '2026-12-31')!
    expect(data.closing).toBe(10000)
    expect(data.rows.at(-1)?.balance).toBe(data.closing)
  })

  it('an unknown customer has no statement', () => {
    expect(buildStatement(fixtureSnapshot(), 'nope', '2026-01-01', '2026-12-31')).toBeNull()
  })

  it('the default period is the last three months, like the server', () => {
    expect(defaultPeriod('2026-11-15')).toEqual({ from: '2026-08-15', to: '2026-11-15' })
    expect(defaultPeriod('2026-02-10')).toEqual({ from: '2025-11-10', to: '2026-02-10' })
    expect(defaultPeriod('2026-05-31')).toEqual({ from: '2026-02-28', to: '2026-05-31' })
  })
})
