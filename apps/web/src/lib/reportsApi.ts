import { api } from './api'
import { hebronDay } from './date'

// The reports are computed on the server (SPEC F12), so they need the internet. All amounts are
// integer agorot; `from` and `to` are Hebron days, `yyyy-MM-dd`, both included.

export interface SalesRow {
  period: string
  invoices: number
  gross: number
  returns: number
  net: number
}
export interface SalesReport {
  group: 'day' | 'month'
  rows: SalesRow[]
  invoices: number
  gross: number
  returns: number
  net: number
}

export interface ProductRow {
  id: string
  name: string
  detail: string
  qty: number
  amount: number
}
export interface ProductsReport {
  rows: ProductRow[]
  qty: number
  amount: number
}

export interface MoneyRow {
  key: string
  received: number
  refunded: number
  net: number
}
export interface CollectionsReport {
  by_method: MoneyRow[]
  by_day: MoneyRow[]
  received: number
  refunded: number
  net: number
}

export interface BalanceRow {
  id: string
  name: string
  shop_name: string | null
  phone: string | null
  balance: number
  last_payment_at: string | null
  days_since_payment: number | null
}
export interface BalancesReport {
  rows: BalanceRow[]
  total_owed: number
  total_credit: number
  owing: number
}

export interface StockRow {
  variant_id: string
  product_id: string
  name: string
  color: string | null
  size: string | null
  sku: string
  qty: number
  min_stock: number
}
export interface StockReport {
  low: StockRow[]
  out: StockRow[]
  negative: StockRow[]
}

export interface DamagedRow {
  at: string
  source: 'write_off' | 'return'
  variant_id: string
  name: string
  color: string | null
  size: string | null
  qty: number
  ref: string | null
  note: string | null
}
export interface DamagedReport {
  rows: DamagedRow[]
  write_off_qty: number
  return_qty: number
}

export interface Range {
  from: string
  to: string
}

const q = (range: Range, extra: Record<string, string | number> = {}) =>
  '?' + new URLSearchParams({ from: range.from, to: range.to, ...extra } as Record<string, string>)

export const reportsApi = {
  sales: (range: Range, group: 'day' | 'month') =>
    api<SalesReport>(`/reports/sales${q(range, { group })}`),
  products: (
    range: Range,
    by: 'product' | 'variant' | 'category',
    order: 'top' | 'slow',
    limit = 50,
  ) => api<ProductsReport>(`/reports/products${q(range, { by, order, limit })}`),
  collections: (range: Range) => api<CollectionsReport>(`/reports/collections${q(range)}`),
  balances: () => api<BalancesReport>('/reports/balances'),
  stock: () => api<StockReport>('/reports/stock'),
  damaged: (range: Range) => api<DamagedReport>(`/reports/damaged${q(range)}`),
}

// ---- the periods the screen offers -------------------------------------------------------------

export type Preset = 'today' | 'week' | 'month' | 'lastMonth' | 'quarter' | 'year'

const shift = (day: string, days: number) => {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** The days a preset stands for, counted from `today` (a Hebron `yyyy-MM-dd`). */
export function presetRange(preset: Preset, today: string): Range {
  const [y = 0, m = 1] = today.split('-').map(Number)
  const first = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}-01`
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case 'week':
      return { from: shift(today, -6), to: today }
    case 'month':
      return { from: first(y, m), to: today }
    case 'lastMonth': {
      const lastY = m === 1 ? y - 1 : y
      const lastM = m === 1 ? 12 : m - 1
      return { from: first(lastY, lastM), to: shift(first(y, m), -1) }
    }
    case 'quarter':
      return { from: shift(today, -89), to: today }
    case 'year':
      return { from: shift(today, -364), to: today }
  }
}

export const todayInHebron = () => hebronDay(new Date().toISOString())

/** A range the server will accept: in order, and not longer than two years. */
export function rangeOk(range: Range): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)) return false
  if (range.from > range.to) return false
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1
  return days <= 731 && range.from >= '2000-01-01' && range.to <= '2100-12-31'
}
