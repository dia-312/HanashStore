import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ar } from '../../i18n/ar'
import Reports from './Reports'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const SALES = {
  group: 'day',
  invoices: 3,
  gross: 7000,
  returns: 1000,
  net: 6000,
  rows: [
    { period: '2026-11-01', invoices: 1, gross: 2000, returns: 0, net: 2000 },
    { period: '2026-11-02', invoices: 2, gross: 5000, returns: 1000, net: 4000 },
  ],
}

let calls: string[] = []
let failNext = false

const stubServer = (extra: Record<string, unknown> = {}) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url)
      if (failNext) {
        failNext = false
        return json({ code: 'INTERNAL', message: 'x', details: {} }, 500)
      }
      const path = url.split('?')[0]
      const bodies: Record<string, unknown> = {
        '/api/v1/reports/sales': SALES,
        '/api/v1/reports/products': {
          by: 'product',
          qty: 3,
          amount: 6000,
          rows: [{ id: 'p', name: 'أرجيلة', detail: 'أراجيل', qty: 3, amount: 6000 }],
        },
        '/api/v1/reports/collections': {
          received: 2700,
          refunded: 200,
          net: 2500,
          by_method: [
            { key: 'cash', received: 1700, refunded: 200, net: 1500 },
            { key: 'transfer', received: 1000, refunded: 0, net: 1000 },
            { key: 'cheque', received: 0, refunded: 0, net: 0 },
          ],
          by_day: [{ key: '2026-11-01', received: 700, refunded: 200, net: 500 }],
        },
        '/api/v1/reports/balances': {
          total_owed: 3934,
          total_credit: 0,
          owing: 2,
          rows: [
            {
              id: 'a',
              name: 'بلال',
              shop_name: 'محل النور',
              phone: null,
              balance: 3500,
              last_payment_at: '2026-10-30T10:00:00Z',
              days_since_payment: 4,
            },
            {
              id: 'b',
              name: 'أحمد',
              shop_name: null,
              phone: null,
              balance: 434,
              last_payment_at: null,
              days_since_payment: null,
            },
            {
              id: 'c',
              name: 'دائن',
              shop_name: null,
              phone: null,
              balance: -500,
              last_payment_at: null,
              days_since_payment: null,
            },
          ],
        },
        '/api/v1/reports/stock': {
          low: [row('l', 3)],
          out: [row('o', 0)],
          negative: [row('n', -2)],
        },
        '/api/v1/reports/damaged': {
          write_off_qty: 4,
          return_qty: 1,
          rows: [
            {
              at: '2026-11-02T09:00:00Z',
              source: 'write_off',
              variant_id: 'v',
              name: 'فحم',
              color: null,
              size: '25',
              qty: 4,
              ref: null,
              note: 'سقطت',
            },
            {
              at: '2026-11-01T09:00:00Z',
              source: 'return',
              variant_id: 'w',
              name: 'أرجيلة',
              color: 'أسود',
              size: null,
              qty: 1,
              ref: 'RET-000004',
              note: null,
            },
          ],
        },
        ...extra,
      }
      return json(bodies[path ?? ''] ?? {})
    }),
  )

function row(id: string, qty: number) {
  return {
    variant_id: id,
    product_id: `p-${id}`,
    name: `منتج ${id}`,
    color: 'أسود',
    size: null,
    sku: id,
    qty,
    min_stock: 5,
  }
}

const renderReports = () =>
  render(
    <MemoryRouter>
      <Reports />
    </MemoryRouter>,
  )

beforeEach(() => {
  calls = []
  failNext = false
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  stubServer()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const tab = (name: string) => screen.getByRole('tab', { name })

describe('reports screen', () => {
  it('opens on sales: this month so far, by day, with totals, a chart and a table', async () => {
    renderReports()
    expect(await screen.findByText('₪ 60.00')).toBeTruthy() // the net total
    const url = new URL(calls[0]!, 'http://x')
    expect(url.pathname).toBe('/api/v1/reports/sales')
    expect(url.searchParams.get('group')).toBe('day')
    expect(url.searchParams.get('from')?.endsWith('-01')).toBe(true)
    expect(screen.getByRole('img', { name: ar.reports.sales.chart })).toBeTruthy()
    const rows = screen.getAllByRole('row')
    // header + 2 days, the latest first
    expect(rows).toHaveLength(3)
    expect(within(rows[1]!).getByText('02/11/2026')).toBeTruthy()
    expect(within(rows[1]!).getByText('₪ 40.00')).toBeTruthy()
  })

  it('a preset asks for its days; the monthly grouping asks for months', async () => {
    renderReports()
    await screen.findByText('₪ 60.00')
    fireEvent.click(screen.getByRole('button', { name: ar.reports.presets.week }))
    await waitFor(() => {
      const last = new URL(calls[calls.length - 1]!, 'http://x').searchParams
      expect(last.get('from')).not.toBeNull()
    })
    fireEvent.click(screen.getByRole('button', { name: ar.reports.sales.month }))
    await waitFor(() =>
      expect(new URL(calls[calls.length - 1]!, 'http://x').searchParams.get('group')).toBe('month'),
    )
  })

  it('a wrong custom period is said so and nothing is asked of the server', async () => {
    renderReports()
    await screen.findByText('₪ 60.00')
    fireEvent.click(screen.getByRole('button', { name: ar.reports.presets.custom }))
    fireEvent.change(screen.getByLabelText(ar.reports.from), { target: { value: '2026-12-31' } })
    fireEvent.change(screen.getByLabelText(ar.reports.to), { target: { value: '2026-01-01' } })
    expect(await screen.findByText(ar.reports.badRange)).toBeTruthy()
    expect(screen.queryByRole('img', { name: ar.reports.sales.chart })).toBeNull()
    const last = calls[calls.length - 1]!
    expect(new URL(last, 'http://x').searchParams.get('from')).not.toBe('2026-12-31')
  })

  it('a failed report says so and the retry asks again', async () => {
    failNext = true
    renderReports()
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: ar.reports.retry }))
    expect(await screen.findByText('₪ 60.00')).toBeTruthy()
  })

  it('products: top and slow, and by what', async () => {
    renderReports()
    fireEvent.click(tab(ar.reports.tabs.products))
    expect(await screen.findByText('أرجيلة')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: ar.reports.products.slow }))
    fireEvent.click(screen.getByRole('button', { name: ar.reports.products.variant }))
    await waitFor(() => {
      const last = new URL(calls[calls.length - 1]!, 'http://x').searchParams
      expect([last.get('order'), last.get('by')]).toEqual(['slow', 'variant'])
    })
  })

  it('collections: cash first, the refund apart, totals', async () => {
    renderReports()
    fireEvent.click(tab(ar.reports.tabs.collections))
    const cash = (await screen.findByText(ar.home.method.cash)).closest('tr')!
    expect(within(cash).getByText('₪ 17.00')).toBeTruthy()
    expect(within(cash).getByText('₪ 2.00')).toBeTruthy()
    expect(within(cash).getByText('₪ 15.00')).toBeTruthy()
  })

  it('balances: only those who owe, by balance, with days since the last payment; a link each', async () => {
    renderReports()
    fireEvent.click(tab(ar.reports.tabs.balances))
    const first = await screen.findByRole('link', { name: 'بلال' })
    expect(first.getAttribute('href')).toBe('/customers/a')
    expect(screen.queryByText('دائن')).toBeNull() // in credit: hidden by "only those who owe"
    expect(screen.getByText(ar.reports.balances.never)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: ar.reports.balances.onlyOwing }))
    expect(await screen.findByText('دائن')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: ar.reports.balances.byDays }))
    // by days since the last payment, the longest first: someone who never paid counts as longest
    await waitFor(() => {
      const names = screen.getAllByRole('link').map((a) => a.textContent)
      expect(names.indexOf('أحمد')).toBeLessThan(names.indexOf('بلال'))
    })
  })

  it('stock: three lists with their own symbol and word', async () => {
    renderReports()
    fireEvent.click(tab(ar.reports.tabs.stock))
    expect(await screen.findByText('منتج n')).toBeTruthy()
    expect(screen.getByText('منتج o')).toBeTruthy()
    expect(screen.getByText('منتج l')).toBeTruthy()
    expect(screen.getByText(ar.reports.stock.negativeHint)).toBeTruthy()
    expect(screen.getByText('منتج l').closest('a')?.getAttribute('href')).toBe('/catalog/p-l')
  })

  it('damaged: write-offs and damaged returns with where they come from', async () => {
    renderReports()
    fireEvent.click(tab(ar.reports.tabs.damaged))
    expect(await screen.findByText('سقطت')).toBeTruthy()
    expect(screen.getByText('RET-000004')).toBeTruthy()
    expect(screen.getByText(ar.reports.damaged.writeOff)).toBeTruthy()
    expect(screen.getAllByText(ar.reports.damaged.returned).length).toBeGreaterThan(0)
  })

  it('offline: says it needs the internet and asks for nothing', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    renderReports()
    expect(await screen.findByText(ar.reports.needsInternet)).toBeTruthy()
    expect(calls).toHaveLength(0)
  })
})
