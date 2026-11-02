import { db, type DbPayment } from '../db'
import { hebronDay } from './date'
import { pendingBalances } from './sync/effectiveBalance'
import { pendingStock } from './sync/effectiveStock'
import { pendingCount, rejectedCommands } from './sync/outbox'

// The numbers on the home screen (SPEC F12), worked out on the device from the device's own rows,
// so they work offline and already include what has not been sent yet. The definitions are the
// server's (`apps/api/app/services/reports.py`): sales = confirmed invoices minus returns, by
// Hebron calendar day; a cancelled invoice and a voided payment never count; collections are
// money received by method, with money handed back (a refund) shown beside it.

export const METHODS = ['cash', 'transfer', 'cheque'] as const
export type Method = (typeof METHODS)[number]

export interface MoneyByMethod {
  received: number
  refunded: number
  net: number
}

export interface Dashboard {
  /** `yyyy-MM-dd`, Hebron. */
  today: string
  salesToday: { invoices: number; gross: number; returns: number; net: number }
  collectionsToday: Record<Method, MoneyByMethod> & { total: MoneyByMethod }
  month: {
    /** This month, 1st to today. */
    net: number
    invoices: number
    /** The whole of last month. */
    lastNet: number
    /** Last month over the same number of days, the fair comparison. */
    lastSameDaysNet: number
    /** Percent, whole; null when last month's same days had no sales. */
    changePercent: number | null
    days: number
  }
  owed: { total: number; customers: number; credit: number }
  stock: { low: number; out: number }
  sync: { pending: number; rejected: number }
}

/** What the calculation reads; plain rows so it can be tested without a database. */
export interface DashboardInput {
  now: string
  invoices: { status: 'confirmed' | 'cancelled'; total: number; issued_at: string }[]
  returns: { total: number; issued_at: string }[]
  payments: Pick<DbPayment, 'kind' | 'method' | 'amount' | 'paid_at' | 'status'>[]
  customers: { id: string; balance: number }[]
  /** Commands still waiting, for the balances. */
  outbox: Parameters<typeof pendingBalances>[1]
  variants: {
    stock_qty: number
    min_stock: number
    is_active: boolean
    product_id: string
    id: string
  }[]
  activeProducts: ReadonlySet<string>
  /** Variants whose quantity a waiting command changes: their quantity now. */
  stockNow: ReadonlyMap<string, number>
  pending: number
  rejected: number
}

const ymd = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

const zero = (): MoneyByMethod => ({ received: 0, refunded: 0, net: 0 })

export function buildDashboard(input: DashboardInput): Dashboard {
  const today = hebronDay(input.now)
  const [year = 0, month = 1, dayOfMonth = 1] = today.split('-').map(Number)
  const monthStart = ymd(year, month, 1)
  const lastYear = month === 1 ? year - 1 : year
  const lastMonth = month === 1 ? 12 : month - 1
  const lastStart = ymd(lastYear, lastMonth, 1)
  const lastEnd = ymd(lastYear, lastMonth, daysIn(lastYear, lastMonth))
  const lastSameEnd = ymd(lastYear, lastMonth, Math.min(dayOfMonth, daysIn(lastYear, lastMonth)))

  const net = (from: string, to: string) => {
    let gross = 0
    let invoices = 0
    let returns = 0
    for (const inv of input.invoices) {
      if (inv.status !== 'confirmed') continue
      const day = hebronDay(inv.issued_at)
      if (day >= from && day <= to) {
        gross += inv.total
        invoices += 1
      }
    }
    for (const ret of input.returns) {
      const day = hebronDay(ret.issued_at)
      if (day >= from && day <= to) returns += ret.total
    }
    return { invoices, gross, returns, net: gross - returns }
  }

  const salesToday = net(today, today)
  const thisMonth = net(monthStart, today)
  const lastNet = net(lastStart, lastEnd).net
  const lastSameDaysNet = net(lastStart, lastSameEnd).net

  const collectionsToday = {
    cash: zero(),
    transfer: zero(),
    cheque: zero(),
    total: zero(),
  }
  for (const p of input.payments) {
    if (p.status !== 'active' || hebronDay(p.paid_at) !== today) continue
    const field = p.kind === 'refund' ? 'refunded' : 'received'
    for (const row of [collectionsToday[p.method], collectionsToday.total]) row[field] += p.amount
  }
  for (const row of Object.values(collectionsToday)) row.net = row.received - row.refunded

  const base = new Map(input.customers.map((c) => [c.id, c.balance]))
  const changed = pendingBalances(base, input.outbox)
  let owedTotal = 0
  let owing = 0
  let credit = 0
  for (const [id, balance] of base) {
    const now = changed.get(id) ?? balance
    if (now > 0) {
      owedTotal += now
      owing += 1
    } else if (now < 0) credit -= now
  }

  let low = 0
  let out = 0
  for (const v of input.variants) {
    if (!v.is_active || !input.activeProducts.has(v.product_id)) continue
    const qty = input.stockNow.get(v.id) ?? v.stock_qty
    if (qty <= 0) out += 1
    else if (qty <= v.min_stock) low += 1
  }

  return {
    today,
    salesToday,
    collectionsToday,
    month: {
      net: thisMonth.net,
      invoices: thisMonth.invoices,
      lastNet,
      lastSameDaysNet,
      changePercent:
        lastSameDaysNet > 0
          ? Math.round(((thisMonth.net - lastSameDaysNet) * 100) / lastSameDaysNet)
          : null,
      days: dayOfMonth,
    },
    owed: { total: owedTotal, customers: owing, credit },
    stock: { low, out },
    sync: { pending: input.pending, rejected: input.rejected },
  }
}

/** The start of last month in UTC text, with a day to spare so the Hebron midnight is inside. */
function since(now: string): string {
  const [year = 0, month = 1] = hebronDay(now).split('-').map(Number)
  const lastYear = month === 1 ? year - 1 : year
  const lastMonth = month === 1 ? 12 : month - 1
  const start = new Date(Date.UTC(lastYear, lastMonth - 1, 1) - 24 * 3_600_000)
  return start.toISOString()
}

/** Reads only what the numbers need: two months of invoices and returns, today's payments. */
export async function loadDashboard(now = new Date().toISOString()): Promise<Dashboard> {
  const from = since(now)
  const dayAgo = new Date(Date.parse(now) - 36 * 3_600_000).toISOString()
  const [invoices, returns, payments, customers, outbox, variants, products, pending, rejected] =
    await Promise.all([
      db.invoices.where('issued_at').aboveOrEqual(from).toArray(),
      db.returns.where('issued_at').aboveOrEqual(from).toArray(),
      db.payments.where('paid_at').aboveOrEqual(dayAgo).toArray(),
      db.customers.toArray(),
      db.outbox.where('status').equals('pending').sortBy('seq'),
      db.variants.toArray(),
      db.products.toArray(),
      pendingCount(),
      rejectedCommands().then((r) => r.length),
    ])
  return buildDashboard({
    now,
    invoices,
    returns,
    payments,
    customers,
    outbox,
    variants,
    activeProducts: new Set(products.filter((p) => p.is_active).map((p) => p.id)),
    stockNow: pendingStock(new Map(variants.map((v) => [v.id, v.stock_qty])), outbox),
    pending,
    rejected,
  })
}
