import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, setMeta, wipeLocalData, type DbCustomer, type DbVariant } from '../../db'
import { ar } from '../../i18n/ar'
import { getCart } from '../../lib/cart'
import { freshAttempts } from '../../lib/lock'
import { createPinRecord } from '../../lib/pin'
import { resetAuthStore, useAuth } from '../../store'
import Present from './Present'

// jsdom has no layout, so the real virtualizer would show no rows; this stand-in lists every row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 100,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 100 })),
    measureElement: () => undefined,
  }),
}))

const customer = (id: string, name: string, balance = 0): DbCustomer => ({
  id,
  name,
  shop_name: null,
  phone: null,
  area: null,
  address: null,
  notes: null,
  opening_balance: 0,
  search_text: name,
  is_active: true,
  balance,
  change_seq: 2,
})

const variant = (id: string, extra: Partial<DbVariant> = {}): DbVariant => ({
  id,
  product_id: 'p1',
  sku: `SKU-${id}`,
  color: null,
  size: null,
  price: 4500,
  min_stock: 2,
  stock_qty: 37,
  is_active: true,
  change_seq: 1,
  ...extra,
})

const renderPresent = (path = '/present/c-1') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="present/:customerId?" element={<Present />} />
        <Route path="checkout/:customerId?" element={<p>صفحة الدفع</p>} />
        <Route path="customers/:customerId" element={<p>صفحة الزبون</p>} />
        <Route path="catalog" element={<p>صفحة الكتالوج</p>} />
      </Routes>
    </MemoryRouter>,
  )

const pressPin = async (pin: string) => {
  for (const digit of pin) {
    fireEvent.click(screen.getByRole('button', { name: digit }))
  }
}

beforeEach(async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  await wipeLocalData()
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
  await setMeta('pin', await createPinRecord('1234', 1000))
  resetAuthStore()
  useAuth.setState({ status: 'unlocked', pinLength: 4, attempts: freshAttempts() })
  await db.categories.put({
    id: 'cat',
    name: 'أراجيل',
    sort_order: 0,
    is_active: true,
    change_seq: 1,
  })
  await db.products.put({
    id: 'p1',
    category_id: 'cat',
    name: 'أرجيلة كبيرة',
    description: 'أرجيلة فاخرة',
    search_text: 'ارجيله كبيره ارجيله',
    is_active: true,
    change_seq: 1,
  })
  await db.variants.bulkPut([
    variant('v1', { color: 'أسود', stock_qty: 37 }),
    variant('v2', { color: 'أحمر', stock_qty: 3, min_stock: 3, price: 5000 }),
    variant('v3', { color: 'ذهبي', stock_qty: 0 }),
  ])
  await db.customers.bulkPut([customer('c-1', 'أحمد', 15000), customer('c-2', 'بلال السري', 99900)])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const openProduct = async () => {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(ar.present.all) }))
  fireEvent.click(await screen.findByRole('button', { name: /أرجيلة كبيرة/ }))
  await screen.findByText('أرجيلة فاخرة')
}

describe('presentation mode (customer-safe)', () => {
  it('shows category tiles and the active customer, and nothing private', async () => {
    renderPresent()
    expect(await screen.findByText('أراجيل')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /أحمد/ })).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('بلال') // another customer
    expect(text).not.toMatch(/150\.00|999\.00/) // any balance
    expect(text).not.toContain(ar.customers.balance)
  })

  it('shows availability as a badge and never the quantity on the shelf', async () => {
    renderPresent()
    await openProduct()
    expect(screen.getAllByText(ar.present.available).length).toBeGreaterThan(0)
    expect(screen.getByText(ar.present.limited)).toBeTruthy() // 3 on the shelf, alert level 3
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\b37\b/)
  })

  it('does not offer an out-of-stock variant', async () => {
    renderPresent()
    await openProduct()
    expect(screen.queryByText('ذهبي')).toBeNull()
    expect(screen.getByText(/أسود/)).toBeTruthy()
  })

  it('adds to the cart, changes the quantity, and the stepper stops at what is on the shelf', async () => {
    renderPresent()
    await openProduct()
    const red = screen.getByText(/أحمر/).closest('li')!
    fireEvent.click(within(red).getByRole('button', { name: ar.present.add }))
    await waitFor(async () =>
      expect((await getCart('c-1'))?.lines).toEqual([{ variant_id: 'v2', qty: 1 }]),
    )
    const plus = () =>
      within(screen.getByText(/أحمر/).closest('li')!).getByRole('button', {
        name: ar.present.increase,
      })
    fireEvent.click(await waitFor(() => plus()))
    await waitFor(async () => expect((await getCart('c-1'))?.lines[0]?.qty).toBe(2))
    // the stepper has re-rendered with the new quantity
    await waitFor(() =>
      expect(within(screen.getByText(/أحمر/).closest('li')!).getByText('2')).toBeTruthy(),
    )
    fireEvent.click(plus())
    await waitFor(async () => expect((await getCart('c-1'))?.lines[0]?.qty).toBe(3))
    await waitFor(() => expect((plus() as HTMLButtonElement).disabled).toBe(true)) // 3 on the shelf
    fireEvent.click(plus())
    expect((await getCart('c-1'))?.lines[0]?.qty).toBe(3)
  })

  it('shows the cart with the total before any discount', async () => {
    renderPresent()
    await openProduct()
    const black = screen.getByText(/أسود/).closest('li')!
    fireEvent.click(within(black).getByRole('button', { name: ar.present.add }))
    await waitFor(async () => expect(await getCart('c-1')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ar.present.cart) }))
    const sheet = await screen.findByRole('dialog', { name: ar.present.cart })
    expect(within(sheet).getByText('أرجيلة كبيرة')).toBeTruthy()
    expect(within(sheet).getAllByText(/45\.00/).length).toBeGreaterThan(0)
  })

  it('"خلصت" needs the PIN: a wrong one is refused, the right one goes to checkout', async () => {
    renderPresent()
    await openProduct()
    fireEvent.click(
      within(screen.getByText(/أسود/).closest('li')!).getByRole('button', { name: ar.present.add }),
    )
    await waitFor(async () => expect(await getCart('c-1')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ar.present.cart) }))
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: ar.present.cart })).getByRole('button', {
        name: ar.present.done,
      }),
    )

    await screen.findByRole('dialog', { name: ar.present.done })
    await pressPin('9999')
    expect(await screen.findByText(ar.lock.wrong)).toBeTruthy()
    expect(screen.queryByText('صفحة الدفع')).toBeNull()
    await pressPin('1234')
    expect(await screen.findByText('صفحة الدفع')).toBeTruthy()
  })

  it('the lock icon asks for the PIN before leaving', async () => {
    renderPresent()
    await screen.findByText('أراجيل')
    fireEvent.click(screen.getByRole('button', { name: ar.present.exit }))
    await screen.findByRole('dialog', { name: ar.present.exitTitle })
    await pressPin('1234')
    expect(await screen.findByText('صفحة الزبون')).toBeTruthy()
  })

  it('with no customer it still works, and leaving goes to the catalog', async () => {
    renderPresent('/present')
    expect(await screen.findByRole('heading', { name: ar.present.title })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: ar.present.exit }))
    await pressPin('1234')
    expect(await screen.findByText('صفحة الكتالوج')).toBeTruthy()
  })

  it('searching finds products and an empty search says so', async () => {
    renderPresent()
    await screen.findByText('أراجيل')
    fireEvent.change(screen.getByRole('searchbox', { name: ar.present.search }), {
      target: { value: 'لا يوجد' },
    })
    expect(await screen.findByText(ar.present.noProducts)).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: ar.present.search }), {
      target: { value: 'ارجيله' },
    })
    expect(await screen.findByRole('button', { name: /أرجيلة كبيرة/ })).toBeTruthy()
  })
})
