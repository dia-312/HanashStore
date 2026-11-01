import { beforeEach, describe, expect, it } from 'vitest'
import { db, setMeta, wipeLocalData } from '../db'
import { buildStatement } from './documents'
import { effectiveBalances, loadSalesSnapshot } from './localSales'
import { cancelInvoice, confirmSale, recordPayment, voidPayment } from './sales'

// SPEC milestone 6, done when: "statement totals equal the balance formula". The server side of
// this is apps/api/tests/test_payments.py; this is the device: a random mix of sales, payments,
// voids and cancellations made offline, then the balance worked out from the rules written out
// again here, compared with the balance on screen and with the statement.

const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

beforeEach(async () => {
  await wipeLocalData()
  await setMeta('identity', { user: { id: 'u', name: 'Rep' }, device: { id: 'd1', name: 'iPad' } })
  await db.products.put({
    id: 'p1',
    category_id: 'cat',
    name: 'أرجيلة',
    description: null,
    search_text: 'ارجيله',
    is_active: true,
    change_seq: 1,
  })
  await db.variants.put({
    id: 'v1',
    product_id: 'p1',
    sku: 'S1',
    color: null,
    size: null,
    price: 1250,
    min_stock: 0,
    stock_qty: 1000,
    is_active: true,
    change_seq: 1,
  })
})

async function randomHistory(seed: number, opening: number) {
  const random = mulberry(seed)
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!
  await db.customers.put({
    id: 'c',
    name: 'زبون',
    shop_name: null,
    phone: null,
    area: null,
    address: null,
    notes: null,
    opening_balance: opening,
    search_text: 'زبون',
    is_active: true,
    balance: opening,
    change_seq: 1,
  })
  const sales: { id: string; total: number; paymentId: string | null; paid: number }[] = []
  const standalone: { id: string; amount: number }[] = []
  const cancelled = new Set<string>()
  const cancelledWithVoid = new Set<string>()
  const voided = new Set<string>()

  for (let step = 0; step < 14; step++) {
    const kind = pick(['sale', 'sale', 'pay', 'pay', 'void', 'cancel'])
    if (kind === 'sale') {
      const qty = 1 + Math.floor(random() * 4)
      const paid = pick([0, 0, 500, 3000])
      const { invoiceId } = await confirmSale({
        customerId: 'c',
        lines: [{ variantId: 'v1', qty }],
        discount: pick([0, 0, 100]),
        paid,
        method: 'cash',
      })
      const invoice = (await db.invoices.get(invoiceId))!
      const payment = (await db.payments.where('invoice_id').equals(invoiceId).first()) ?? null
      sales.push({ id: invoiceId, total: invoice.total, paymentId: payment?.id ?? null, paid })
    } else if (kind === 'pay') {
      const amount = pick([400, 1000, 8000])
      const { paymentId } = await recordPayment({ customerId: 'c', amount, method: 'cash' })
      standalone.push({ id: paymentId, amount })
    } else if (kind === 'void') {
      const candidates = [
        ...standalone.map((p) => p.id),
        ...sales
          .filter((s) => s.paymentId && !cancelledWithVoid.has(s.id))
          .map((s) => s.paymentId!),
      ].filter((id) => !voided.has(id))
      if (candidates.length === 0) continue
      const id = pick(candidates)
      await voidPayment(id, 'خطأ')
      voided.add(id)
    } else {
      const open = sales.filter((s) => !cancelled.has(s.id))
      if (open.length === 0) continue
      const sale = pick(open)
      const withVoid = random() < 0.5
      await cancelInvoice(sale.id, 'خطأ', withVoid)
      cancelled.add(sale.id)
      if (withVoid) cancelledWithVoid.add(sale.id)
    }
  }

  // the rules, written out again: opening + invoices that still stand - payments that still count
  let expected = opening
  for (const sale of sales) {
    if (!cancelled.has(sale.id)) expected += sale.total
    const paymentCounts =
      sale.paymentId !== null && !voided.has(sale.paymentId) && !cancelledWithVoid.has(sale.id)
    if (paymentCounts) expected -= sale.paid
  }
  for (const payment of standalone) if (!voided.has(payment.id)) expected -= payment.amount
  return expected
}

describe('the statement and the balance agree after any mix of sales, payments, voids and cancels', () => {
  for (let seed = 1; seed <= 15; seed++) {
    it(`seed ${seed}`, async () => {
      const opening = [0, 7500, -2500][seed % 3]!
      const expected = await randomHistory(seed, opening)
      const snapshot = await loadSalesSnapshot()
      const shown = effectiveBalances(snapshot).get('c')
      expect(shown).toBe(expected)

      const everything = buildStatement(snapshot, 'c', '2000-01-01', '2999-12-31')!
      // counted back from today's balance, the opening row must land on the real opening balance
      expect(everything.rows[0]!.balance).toBe(opening)
      expect(everything.closing).toBe(expected)
      let running = everything.rows[0]!.balance
      for (const row of everything.rows.slice(1)) {
        running += row.debit - row.credit
        expect(row.balance).toBe(running)
      }
      expect(everything.totalDebit - everything.totalCredit).toBe(expected - opening)

      // the toggle only adds rows that do not count
      const withOff = buildStatement(snapshot, 'c', '2000-01-01', '2999-12-31', true)!
      expect(withOff.closing).toBe(expected)
      expect(withOff.rows[0]!.balance).toBe(opening)
    })
  }
})
