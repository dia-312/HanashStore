import { beforeEach, describe, expect, it } from 'vitest'
import { db, wipeLocalData } from '../db'
import { buildDashboard, loadDashboard, type DashboardInput } from './dashboard'
import { confirmSale, recordPayment, recordRefund, saveCustomer } from './sales'

// "Today" is Tuesday 03/11/2026, 11:00 in Hebron (UTC+2 since the clocks went back on 24/10).
const NOW = '2026-11-03T09:00:00Z'

const input = (extra: Partial<DashboardInput> = {}): DashboardInput => ({
  now: NOW,
  invoices: [],
  returns: [],
  payments: [],
  customers: [],
  outbox: [],
  variants: [],
  activeProducts: new Set(),
  stockNow: new Map(),
  pending: 0,
  rejected: 0,
  ...extra,
})

const invoice = (
  issued_at: string,
  total: number,
  status: 'confirmed' | 'cancelled' = 'confirmed',
) => ({
  issued_at,
  total,
  status,
})
const pay = (
  paid_at: string,
  amount: number,
  method: 'cash' | 'transfer' | 'cheque' = 'cash',
  extra: { kind?: 'payment' | 'refund'; status?: 'active' | 'voided' } = {},
) => ({ paid_at, amount, method, kind: extra.kind ?? 'payment', status: extra.status ?? 'active' })

describe('sales', () => {
  it('today is a Hebron day: 00:30 local on the 3rd (22:30Z on the 2nd) counts today', () => {
    const d = buildDashboard(
      input({
        invoices: [
          invoice('2026-11-02T21:59:59Z', 100), // 23:59:59 on the 2nd
          invoice('2026-11-02T22:00:00Z', 1500), // midnight: the 3rd
          invoice('2026-11-03T08:00:00Z', 2500),
        ],
      }),
    )
    expect(d.today).toBe('2026-11-03')
    expect(d.salesToday).toEqual({ invoices: 2, gross: 4000, returns: 0, net: 4000 })
  })

  it('returns reduce sales on the day they were made, and a cancelled invoice never counts', () => {
    const d = buildDashboard(
      input({
        invoices: [
          invoice('2026-11-03T07:00:00Z', 3000),
          invoice('2026-11-03T08:00:00Z', 9999, 'cancelled'),
        ],
        returns: [
          { total: 966, issued_at: '2026-11-03T08:30:00Z' },
          { total: 500, issued_at: '2026-11-02T08:30:00Z' }, // yesterday: not today's
        ],
      }),
    )
    expect(d.salesToday).toEqual({ invoices: 1, gross: 3000, returns: 966, net: 2034 })
    expect(d.month.net).toBe(3000 - 966 - 500)
  })

  it('this month against the same days of last month, and against the whole of last month', () => {
    const d = buildDashboard(
      input({
        invoices: [
          invoice('2026-11-01T10:00:00Z', 1000),
          invoice('2026-11-03T10:00:00Z', 2000),
          invoice('2026-10-02T10:00:00Z', 1500), // inside the same 3 days of October
          invoice('2026-10-20T10:00:00Z', 6000), // later in October: in the whole month only
          invoice('2026-09-30T10:00:00Z', 777), // not October
        ],
      }),
    )
    expect(d.month).toMatchObject({
      net: 3000,
      invoices: 2,
      lastNet: 7500,
      lastSameDaysNet: 1500,
      changePercent: 100,
      days: 3,
    })
  })

  it('no sales in the same days of last month means no percentage, not a division by zero', () => {
    const d = buildDashboard(input({ invoices: [invoice('2026-11-02T10:00:00Z', 500)] }))
    expect(d.month.changePercent).toBeNull()
    expect(d.month.lastSameDaysNet).toBe(0)
  })

  it('a fall is a negative percentage, rounded to whole numbers', () => {
    const d = buildDashboard(
      input({
        invoices: [invoice('2026-11-02T10:00:00Z', 1000), invoice('2026-10-02T10:00:00Z', 3000)],
      }),
    )
    expect(d.month.changePercent).toBe(-67)
  })

  it('in January last month is December of the year before', () => {
    const d = buildDashboard(
      input({
        now: '2027-01-05T09:00:00Z',
        invoices: [
          invoice('2026-12-02T10:00:00Z', 400),
          invoice('2026-12-20T10:00:00Z', 600),
          invoice('2027-01-04T10:00:00Z', 800),
        ],
      }),
    )
    expect(d.month).toMatchObject({ net: 800, lastNet: 1000, lastSameDaysNet: 400 })
  })

  it('on the 31st, when last month had 30 days, the comparison stops at its last day', () => {
    const d = buildDashboard(
      input({
        now: '2026-12-31T09:00:00Z', // last month is November: 30 days
        invoices: [invoice('2026-11-30T10:00:00Z', 900), invoice('2026-12-31T10:00:00Z', 1800)],
      }),
    )
    expect(d.month).toMatchObject({ lastNet: 900, lastSameDaysNet: 900, changePercent: 100 })
  })
})

describe('collections', () => {
  it('money received by method, money handed back beside it, voided and other days left out', () => {
    const d = buildDashboard(
      input({
        payments: [
          pay('2026-11-03T07:00:00Z', 700),
          pay('2026-11-03T07:30:00Z', 1000, 'transfer'),
          pay('2026-11-03T08:00:00Z', 200, 'cash', { kind: 'refund' }),
          pay('2026-11-03T08:10:00Z', 300, 'cash', { status: 'voided' }),
          pay('2026-11-02T08:00:00Z', 5000), // yesterday
          pay('2026-11-03T08:20:00Z', 450, 'cheque'),
        ],
      }),
    )
    expect(d.collectionsToday.cash).toEqual({ received: 700, refunded: 200, net: 500 })
    expect(d.collectionsToday.transfer).toEqual({ received: 1000, refunded: 0, net: 1000 })
    expect(d.collectionsToday.cheque.received).toBe(450)
    expect(d.collectionsToday.total).toEqual({ received: 2150, refunded: 200, net: 1950 })
  })

  it('a payment from before refunds existed (no kind) is money received', () => {
    const d = buildDashboard(
      input({
        payments: [
          { paid_at: '2026-11-03T07:00:00Z', amount: 100, method: 'cash', status: 'active' },
        ],
      }),
    )
    expect(d.collectionsToday.cash.received).toBe(100)
  })
})

describe('owed, stock and sync', () => {
  it('total owed counts only what is owed; credit is apart; waiting commands are included', () => {
    const d = buildDashboard(
      input({
        customers: [
          { id: 'a', balance: 5000 },
          { id: 'b', balance: -1200 },
          { id: 'c', balance: 0 },
          { id: 'd', balance: 300 },
        ],
        outbox: [
          {
            type: 'payment.create',
            status: 'pending',
            payload: { customer_id: 'a', amount: 2000 },
          },
        ],
      }),
    )
    expect(d.owed).toEqual({ total: 3300, customers: 2, credit: 1200 })
  })

  it('a payment that pushes a customer into credit moves him from owed to credit', () => {
    const d = buildDashboard(
      input({
        customers: [{ id: 'a', balance: 1000 }],
        outbox: [
          {
            type: 'payment.create',
            status: 'pending',
            payload: { customer_id: 'a', amount: 1500 },
          },
        ],
      }),
    )
    expect(d.owed).toEqual({ total: 0, customers: 0, credit: 500 })
  })

  it('low and out counts use the quantity with waiting commands, and skip stopped things', () => {
    const v = (id: string, qty: number, min = 5, extra: object = {}) => ({
      id,
      product_id: 'p',
      stock_qty: qty,
      min_stock: min,
      is_active: true,
      ...extra,
    })
    const d = buildDashboard(
      input({
        activeProducts: new Set(['p']),
        variants: [
          v('ok', 50),
          v('low', 5),
          v('out', 0),
          v('neg', -2),
          v('stopped', 0, 5, { is_active: false }),
          v('restocked', 0), // a stock-in is waiting: not out any more
          v('other', 0, 5, { product_id: 'gone' }),
        ],
        stockNow: new Map([['restocked', 20]]),
      }),
    )
    expect(d.stock).toEqual({ low: 1, out: 2 })
  })

  it('passes on the counts of waiting and refused commands', () => {
    expect(buildDashboard(input({ pending: 3, rejected: 1 })).sync).toEqual({
      pending: 3,
      rejected: 1,
    })
  })
})

describe('read from the device', () => {
  beforeEach(async () => {
    await wipeLocalData()
  })

  it('shows work done offline at once: a sale, a payment, a refund', async () => {
    await db.categories.put({ id: 'c', name: 'ف', sort_order: 0, is_active: true, change_seq: 1 })
    await db.products.put({
      id: 'p',
      category_id: 'c',
      name: 'منتج',
      description: null,
      search_text: '',
      is_active: true,
      change_seq: 1,
    })
    await db.variants.put({
      id: 'v',
      product_id: 'p',
      sku: 'S',
      color: null,
      size: null,
      price: 1000,
      min_stock: 3,
      stock_qty: 10,
      is_active: true,
      change_seq: 1,
    })
    const customerId = await saveCustomer({ name: 'محل' })
    const now = new Date().toISOString()
    expect((await loadDashboard(now)).salesToday.invoices).toBe(0)

    await confirmSale({
      customerId,
      lines: [{ variantId: 'v', qty: 4 }],
      discount: 100,
      paid: 500,
      method: 'cash',
    })
    await recordPayment({ customerId, amount: 300, method: 'transfer' })
    await recordRefund({ customerId, amount: 50, method: 'cash' })

    const d = await loadDashboard()
    expect(d.salesToday).toEqual({ invoices: 1, gross: 3900, returns: 0, net: 3900 })
    expect(d.collectionsToday.cash).toEqual({ received: 500, refunded: 50, net: 450 })
    expect(d.collectionsToday.transfer.received).toBe(300)
    // he owes 3900 - 500 - 300 + 50
    expect(d.owed).toEqual({ total: 3150, customers: 1, credit: 0 })
    // 10 - 4 = 6 left, above the alert level of 3
    expect(d.stock).toEqual({ low: 0, out: 0 })
    expect(d.sync.pending).toBe(4) // customer, sale, payment, refund
  })
})
