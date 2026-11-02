import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, wipeLocalData } from '../db'
import { ar } from '../i18n/ar'
import { confirmSale, recordPayment, recordRefund, saveCustomer } from '../lib/sales'
import Home from './Home'

const renderHome = () =>
  render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  )

const seedCatalog = async () => {
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
  await db.variants.bulkPut(
    [
      ['v1', 10, 3],
      ['v2', 2, 3], // low
      ['v3', 0, 3], // out
    ].map(([id, qty, min]) => ({
      id: id as string,
      product_id: 'p',
      sku: id as string,
      color: id as string,
      size: null,
      price: 1000,
      min_stock: min as number,
      stock_qty: qty as number,
      is_active: true,
      change_seq: 1,
    })),
  )
}

beforeEach(async () => {
  await wipeLocalData()
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
  // the home screen reads the device: any call to the network would be a bug
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline')
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('home screen', () => {
  it('without products says so and points to the import; the numbers are zero', async () => {
    renderHome()
    expect(await screen.findByText(ar.home.noProducts, { exact: false })).toBeTruthy()
    expect(screen.getByRole('link', { name: ar.empty.home.next }).getAttribute('href')).toBe(
      '/settings/import',
    )
    const sales = (await screen.findByText(ar.home.salesToday)).closest('section')!
    expect(within(sales).getByText('₪ 0.00')).toBeTruthy()
  })

  it('shows what the rep did today, offline, before anything is sent', async () => {
    await seedCatalog()
    const customerId = await saveCustomer({ name: 'محل' })
    await confirmSale({
      customerId,
      lines: [{ variantId: 'v1', qty: 4 }],
      discount: 100,
      paid: 500,
      method: 'cash',
    })
    await recordPayment({ customerId, amount: 300, method: 'transfer' })
    await recordRefund({ customerId, amount: 50, method: 'cash' })
    renderHome()

    const sales = (await screen.findByText(ar.home.salesToday)).closest('section')!
    await waitFor(() => expect(within(sales).getByText('₪ 39.00')).toBeTruthy())
    expect(within(sales).getByText(/1 فاتورة/)).toBeTruthy()

    const collections = screen.getByText(ar.home.collectionsToday).closest('section')!
    expect(within(collections).getByText(ar.home.method.cash).nextElementSibling?.textContent).toBe(
      '₪ 4.50', // 5.00 received, 0.50 handed back
    )
    expect(
      within(collections).getByText(ar.home.method.transfer).nextElementSibling?.textContent,
    ).toBe('₪ 3.00')
    expect(within(collections).getByText(/₪ 0\.50/)).toBeTruthy() // the refund is said apart

    // he owes 39.00 - 5.00 - 3.00 + 0.50 = 31.50
    const owed = screen.getByText(ar.home.owed).closest('a')!
    expect(within(owed).getByText('₪ 31.50')).toBeTruthy()
    expect(owed.getAttribute('href')).toBe('/customers')

    // four things wait to be sent, and the card says it is not an error
    const unsent = screen.getByText(ar.home.unsent).closest('a')!
    expect(within(unsent).getByText('4')).toBeTruthy()
    expect(within(unsent).getByText(ar.home.waiting)).toBeTruthy()
  })

  it('stock: low and out each with its own symbol and word', async () => {
    await seedCatalog()
    renderHome()
    const stock = (await screen.findByText(ar.home.stock)).closest('a')!
    await waitFor(() => expect(within(stock).getByText(/منخفض/).textContent).toContain('1'))
    expect(within(stock).getByText(/نفد/).textContent).toContain('1')
    expect(stock.textContent).toContain('▲')
    expect(stock.textContent).toContain('✕')
    expect(stock.getAttribute('href')).toBe('/stock')
  })

  it('the quick actions go where they should', async () => {
    renderHome()
    const group = await screen.findByRole('group', { name: ar.home.quick })
    const hrefs = within(group)
      .getAllByRole('link')
      .map((a) => [a.textContent, a.getAttribute('href')])
    expect(hrefs).toEqual([
      [ar.home.newSale, '/present'],
      [ar.home.newPayment, '/customers?pick=payment'],
      [ar.home.stockIn, '/stock'],
    ])
  })

  it('never asks the network for anything', async () => {
    await seedCatalog()
    renderHome()
    await screen.findByText(ar.home.salesToday)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })
})
