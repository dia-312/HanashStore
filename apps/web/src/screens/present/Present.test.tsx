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

// The chosen-variant card, and picking a colour the way the customer does.
const card = () => screen.getByRole('region', { name: ar.present.chosen })
const chooseColor = (name: string) =>
  fireEvent.click(
    within(screen.getByRole('group', { name: ar.present.color })).getByRole('button', { name }),
  )

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
    expect(within(card()).getByText(ar.present.available)).toBeTruthy() // the black one, 37
    chooseColor('أحمر')
    expect(within(card()).getByText(ar.present.limited)).toBeTruthy() // 3 on the shelf, alert level 3
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\b37\b/)
  })

  it('does not offer an out-of-stock variant', async () => {
    renderPresent()
    await openProduct()
    expect(screen.queryByText('ذهبي')).toBeNull()
    expect(screen.getByRole('button', { name: /أسود/ })).toBeTruthy()
  })

  it('adds to the cart, changes the quantity, and the stepper stops at what is on the shelf', async () => {
    renderPresent()
    await openProduct()
    chooseColor('أحمر')
    fireEvent.click(within(card()).getByRole('button', { name: ar.present.add }))
    await waitFor(async () =>
      expect((await getCart('c-1'))?.lines).toEqual([{ variant_id: 'v2', qty: 1 }]),
    )
    const plus = () => within(card()).getByRole('button', { name: ar.present.increase })
    fireEvent.click(await waitFor(() => plus()))
    await waitFor(async () => expect((await getCart('c-1'))?.lines[0]?.qty).toBe(2))
    // the stepper has re-rendered with the new quantity
    await waitFor(() => expect(within(card()).getByText('2')).toBeTruthy())
    fireEvent.click(plus())
    await waitFor(async () => expect((await getCart('c-1'))?.lines[0]?.qty).toBe(3))
    await waitFor(() => expect((plus() as HTMLButtonElement).disabled).toBe(true)) // 3 on the shelf
    fireEvent.click(plus())
    expect((await getCart('c-1'))?.lines[0]?.qty).toBe(3)
  })

  it('shows the cart with the total before any discount', async () => {
    renderPresent()
    await openProduct()
    fireEvent.click(within(card()).getByRole('button', { name: ar.present.add })) // black is first
    await waitFor(async () => expect(await getCart('c-1')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ar.present.cart) }))
    const sheet = await screen.findByRole('dialog', { name: ar.present.cart })
    expect(within(sheet).getByText('أرجيلة كبيرة')).toBeTruthy()
    expect(within(sheet).getAllByText(/45\.00/).length).toBeGreaterThan(0)
  })

  it('"خلصت" needs the PIN: a wrong one is refused, the right one goes to checkout', async () => {
    renderPresent()
    await openProduct()
    fireEvent.click(within(card()).getByRole('button', { name: ar.present.add }))
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

describe('the out-of-stock switch from Settings', () => {
  it('shows an out-of-stock variant, marked unavailable and with nothing to add, when the switch is off', async () => {
    await db.settings.put({ key: 'hide_out_of_stock_in_presentation', value: false })
    renderPresent()
    await openProduct()
    fireEvent.click(await screen.findByRole('button', { name: /ذهبي/ }))
    expect(within(card()).getByText(ar.present.unavailable)).toBeTruthy()
    expect(
      within(card()).getByRole('button', { name: ar.present.add }).hasAttribute('disabled'),
    ).toBe(true)
  })
})

describe('search, colour filter and variants in presentation mode', () => {
  const addCoal = async () => {
    await db.products.put({
      id: 'p2',
      category_id: 'cat',
      name: 'فحم طبيعي',
      description: null,
      search_text: '',
      is_active: true,
      change_seq: 1,
    })
    await db.variants.put(variant('v4', { product_id: 'p2', color: 'أسود', stock_qty: 50 }))
  }

  it('finds a product through a synonym group', async () => {
    await db.synonym_groups.put({
      id: 'g1',
      terms: ['ارجيله', 'شيشه'],
      is_active: true,
      change_seq: 1,
    })
    renderPresent()
    await screen.findByText('أراجيل')
    fireEvent.change(screen.getByRole('searchbox', { name: ar.present.search }), {
      target: { value: 'شيشة' },
    })
    expect(await screen.findByRole('button', { name: /أرجيلة كبيرة/ })).toBeTruthy()
  })

  it('opens the product on the variant the words picked', async () => {
    renderPresent()
    await screen.findByText('أراجيل')
    fireEvent.change(screen.getByRole('searchbox', { name: ar.present.search }), {
      target: { value: 'ارجيله احمر' },
    })
    fireEvent.click(await screen.findByRole('button', { name: /أرجيلة كبيرة/ }))
    await screen.findByText('أرجيلة فاخرة')
    expect(within(card()).getByText(/50\.00/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /أحمر/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('the colour chips narrow the products', async () => {
    await addCoal()
    renderPresent()
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(ar.present.all) }))
    expect(await screen.findByRole('button', { name: /فحم طبيعي/ })).toBeTruthy()
    const chips = within(screen.getByRole('group', { name: ar.present.color }))
    fireEvent.click(chips.getByRole('button', { name: 'أحمر' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /فحم طبيعي/ })).toBeNull())
    expect(screen.getByRole('button', { name: /أرجيلة كبيرة/ })).toBeTruthy()
    fireEvent.click(chips.getByRole('button', { name: ar.present.allColors }))
    expect(await screen.findByRole('button', { name: /فحم طبيعي/ })).toBeTruthy()
  })

  it('choosing a colour brings up its picture in the gallery', async () => {
    const scrollTo = vi.fn()
    Element.prototype.scrollIntoView = scrollTo
    await db.images.bulkPut([
      {
        id: 'i0',
        product_id: 'p1',
        variant_id: null,
        thumb_url: '/media/i0-t.webp',
        full_url: '/media/i0-f.webp',
        sort_order: 0,
        deleted_at: null,
        change_seq: 1,
      },
      {
        id: 'i1',
        product_id: 'p1',
        variant_id: 'v2',
        thumb_url: '/media/i1-t.webp',
        full_url: '/media/i1-f.webp',
        sort_order: 1,
        deleted_at: null,
        change_seq: 1,
      },
    ])
    renderPresent()
    await openProduct()
    const pictures = within(screen.getByRole('group', { name: 'أرجيلة كبيرة' }))
    expect(pictures.getAllByRole('img')).toHaveLength(2) // the product's and the red one's
    scrollTo.mockClear()
    chooseColor('أحمر')
    await waitFor(() => expect(scrollTo).toHaveBeenCalled())
    // the dots say which picture is in view and let the customer jump to one
    expect(screen.getByRole('button', { name: 'الصورة 2' })).toBeTruthy()
    // @ts-expect-error the stand-in is removed again
    delete Element.prototype.scrollIntoView
  })

  it('a colour that is not in the chosen size moves to a variant that exists', async () => {
    await db.variants.bulkPut([
      variant('v1', { color: 'أسود', size: 'كبير', stock_qty: 37 }),
      variant('v2', { color: 'أحمر', size: 'صغير', stock_qty: 3, min_stock: 3, price: 5000 }),
      variant('v3', { color: 'ذهبي', stock_qty: 0 }),
    ])
    renderPresent()
    await openProduct()
    // black comes in large only: asking for red takes its size along, and the price follows
    chooseColor('أحمر')
    expect(within(card()).getByText(/50\.00/)).toBeTruthy()
    fireEvent.click(
      within(screen.getByRole('group', { name: ar.present.size })).getByRole('button', {
        name: /كبير/,
      }),
    )
    expect(within(card()).getByText(/45\.00/)).toBeTruthy()
  })
})

describe('what the customer must never reach', () => {
  it('has no link, menu, balance, invoice, payment or sync detail on any screen', async () => {
    await db.invoices.put({
      id: 'inv-1',
      number: 'INV-000001',
      customer_id: 'c-1',
      status: 'confirmed',
      subtotal: 9000,
      discount: 0,
      total: 9000,
      note: null,
      issued_at: '2026-10-01T10:00:00Z',
      delivered_at: null,
      cancelled_at: null,
      cancel_reason: null,
      change_seq: 3,
    })
    renderPresent()
    const forbidden = [
      ...Object.values(ar.nav),
      ar.customers.balance,
      'بلال', // another customer
      'INV-000001',
      ar.header.syncSynced,
    ]
    const check = () => {
      expect(document.querySelectorAll('a')).toHaveLength(0)
      expect(document.querySelectorAll('nav')).toHaveLength(0)
      const text = document.body.textContent ?? ''
      for (const word of forbidden) expect(text, word).not.toContain(word)
      expect(text).not.toMatch(/\b37\b/) // the shelf quantity of the black one
      expect(text).not.toMatch(/150\.00|999\.00|90\.00/) // balances and the invoice total
    }
    await screen.findByText('أراجيل')
    check()
    await openProduct()
    check()
    fireEvent.click(within(card()).getByRole('button', { name: ar.present.add }))
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(ar.present.cart) }))
    await screen.findByRole('dialog', { name: ar.present.cart })
    check()
  })
})
