import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, setMeta, wipeLocalData, type DbCustomer, type DbImage, type DbVariant } from '../../db'
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

// The chosen-variant card, and picking a variant the way the customer does: by its size, or by its
// name when the product has no sizes. There is no colour step.
const card = () => screen.getByRole('region', { name: ar.present.chosen })
const options = () =>
  screen.queryByRole('group', { name: ar.present.size }) ??
  screen.getByRole('group', { name: ar.present.option })
const choose = (name: string | RegExp) =>
  fireEvent.click(within(options()).getByRole('button', { name }))

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
    choose('أسود')
    expect(within(card()).getByText(ar.present.available)).toBeTruthy() // the black one, 37
    choose('أحمر')
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
    choose('أحمر')
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
    choose('أسود')
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
    choose('أسود')
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

describe('search and variants in presentation mode', () => {
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

  it('has no colour step: no colour buttons and no colour filter anywhere', async () => {
    await addCoal()
    renderPresent()
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(ar.present.all) }))
    expect(await screen.findByRole('button', { name: /فحم طبيعي/ })).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'اللون' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /أرجيلة كبيرة/ }))
    await screen.findByText('أرجيلة فاخرة')
    expect(screen.queryByRole('group', { name: 'اللون' })).toBeNull()
  })

  it('choosing a variant brings up its picture in the gallery', async () => {
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
    choose('أحمر')
    await waitFor(() => expect(scrollTo).toHaveBeenCalled())
    // the dots say which picture is in view and let the customer jump to one
    expect(screen.getByRole('button', { name: 'الصورة 2' })).toBeTruthy()
    // @ts-expect-error the stand-in is removed again
    delete Element.prototype.scrollIntoView
  })

  it('picks nothing for the customer: a prompt and no add button until a size is chosen', async () => {
    await db.variants.bulkPut([
      variant('v1', { color: 'أسود', size: 'كبير', stock_qty: 37 }),
      variant('v2', { color: 'أحمر', size: 'صغير', stock_qty: 3, min_stock: 3, price: 5000 }),
      variant('v3', { color: 'ذهبي', stock_qty: 0 }),
    ])
    renderPresent()
    await openProduct()
    const sizes = within(screen.getByRole('group', { name: ar.present.size }))
    expect(card().textContent).toContain(ar.present.pickSize)
    expect(screen.queryByRole('button', { name: ar.present.add })).toBeNull()
    expect(
      sizes.getAllByRole('button').every((b) => b.getAttribute('aria-pressed') === 'false'),
    ).toBe(true)
    // the colour is not a step: the sizes are all there, whatever their colour
    expect(sizes.getAllByRole('button')).toHaveLength(2)
    fireEvent.click(sizes.getByRole('button', { name: /صغير/ }))
    expect(within(card()).getByText(/50\.00/)).toBeTruthy()
    expect(within(card()).getByRole('button', { name: ar.present.add })).toBeTruthy()
    fireEvent.click(sizes.getByRole('button', { name: /كبير/ }))
    expect(within(card()).getByText(/45\.00/)).toBeTruthy()
  })

  it('two variants of the same size are told apart by their colour, and only then', async () => {
    await db.variants.bulkPut([
      variant('v1', { color: 'أسود', size: 'كبير', stock_qty: 37 }),
      variant('v2', { color: 'أحمر', size: 'صغير', stock_qty: 3, min_stock: 3, price: 5000 }),
      variant('v4', { color: 'أسود', size: 'صغير', stock_qty: 9, price: 4000 }),
      variant('v3', { color: 'ذهبي', stock_qty: 0 }),
    ])
    renderPresent()
    await openProduct()
    const sizes = within(screen.getByRole('group', { name: ar.present.size }))
    expect(sizes.getAllByRole('button').map((b) => b.textContent?.replace('✓ ', ''))).toEqual([
      'كبير',
      'صغير · أحمر',
      'صغير · أسود',
    ])
    fireEvent.click(sizes.getByRole('button', { name: 'صغير · أسود' }))
    expect(within(card()).getByText(/40\.00/)).toBeTruthy()
  })

  it('a product that comes in colours only is chosen by that name, with its own prompt', async () => {
    renderPresent()
    await openProduct()
    expect(screen.queryByRole('group', { name: ar.present.size })).toBeNull()
    expect(card().textContent).toContain(ar.present.pickOption)
    expect(screen.queryByRole('button', { name: ar.present.add })).toBeNull()
    choose('أحمر')
    expect(within(card()).getByRole('button', { name: ar.present.add })).toBeTruthy()
  })

  it('a product with a single variant has nothing to choose', async () => {
    await db.variants.clear()
    await db.variants.put(variant('v1', { color: 'أسود', size: 'كبير', stock_qty: 37 }))
    renderPresent()
    await openProduct()
    expect(screen.queryByRole('group', { name: ar.present.size })).toBeNull()
    expect(within(card()).getByRole('button', { name: ar.present.add })).toBeTruthy()
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
    choose('أسود')
    fireEvent.click(within(card()).getByRole('button', { name: ar.present.add }))
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(ar.present.cart) }))
    await screen.findByRole('dialog', { name: ar.present.cart })
    check()
  })
})

describe('tapping a picture in presentation mode', () => {
  const image = (id: string, extra: Partial<DbImage> = {}): DbImage => ({
    id,
    product_id: 'p1',
    variant_id: null,
    thumb_url: `/media/${id}-t.webp`,
    full_url: `/media/${id}-f.webp`,
    sort_order: 0,
    deleted_at: null,
    change_seq: 1,
    ...extra,
  })
  const addPictures = (...ids: string[]) =>
    db.images.bulkPut(ids.map((id, at) => image(id, { sort_order: at })))
  const zoomButtons = () => screen.getAllByRole('button', { name: ar.present.zoomPicture })
  const viewer = () => screen.findByRole('dialog', { name: 'أرجيلة كبيرة' })

  it('opens every picture of the product over the whole screen, and the close button goes back', async () => {
    await addPictures('i0', 'i1', 'i2')
    renderPresent()
    await openProduct()
    const opener = zoomButtons()[0]!
    opener.focus()
    fireEvent.click(opener)
    const dialog = within(await viewer())
    expect(dialog.getAllByRole('img').map((i) => i.getAttribute('src'))).toEqual([
      '/media/i0-f.webp',
      '/media/i1-f.webp',
      '/media/i2-f.webp',
    ])
    expect(dialog.getByText('1 من 3')).toBeTruthy()
    expect(document.body.style.overflow).toBe('hidden') // the page behind does not scroll
    fireEvent.click(dialog.getByRole('button', { name: ar.present.close }))
    expect(screen.queryByRole('dialog', { name: 'أرجيلة كبيرة' })).toBeNull()
    expect(document.body.style.overflow).not.toBe('hidden')
    expect(document.activeElement).toBe(opener) // the customer is where they were
  })

  it('opens on the picture that was tapped', async () => {
    await addPictures('i0', 'i1', 'i2')
    renderPresent()
    await openProduct()
    fireEvent.click(zoomButtons()[1]!)
    expect(within(await viewer()).getByText('2 من 3')).toBeTruthy()
  })

  it('moves between pictures with the arrows, which stop at the first and the last', async () => {
    await addPictures('i0', 'i1')
    renderPresent()
    await openProduct()
    fireEvent.click(zoomButtons()[0]!)
    const dialog = within(await viewer())
    const prev = dialog.getByRole('button', { name: ar.present.prevPicture }) as HTMLButtonElement
    const next = dialog.getByRole('button', { name: ar.present.nextPicture }) as HTMLButtonElement
    expect(prev.disabled).toBe(true)
    fireEvent.click(next)
    expect(dialog.getByText('2 من 2')).toBeTruthy()
    expect(next.disabled).toBe(true)
    fireEvent.click(prev)
    expect(dialog.getByText('1 من 2')).toBeTruthy()
  })

  it('closes with Escape', async () => {
    await addPictures('i0')
    renderPresent()
    await openProduct()
    fireEvent.click(zoomButtons()[0]!)
    await viewer()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'أرجيلة كبيرة' })).toBeNull()
  })

  it('one picture has no counter and no arrows', async () => {
    await addPictures('i0')
    renderPresent()
    await openProduct()
    fireEvent.click(zoomButtons()[0]!)
    const dialog = within(await viewer())
    expect(dialog.queryByRole('button', { name: ar.present.nextPicture })).toBeNull()
    expect(dialog.queryByText(/من/)).toBeNull()
  })

  it('a product without pictures has nothing to tap', async () => {
    renderPresent()
    await openProduct()
    expect(screen.queryAllByRole('button', { name: ar.present.zoomPicture })).toHaveLength(0)
  })

  it('a deleted picture is not in the viewer', async () => {
    await db.images.bulkPut([
      image('i0'),
      image('i1', { sort_order: 1, deleted_at: '2026-11-01T00:00:00Z' }),
    ])
    renderPresent()
    await openProduct()
    fireEvent.click(zoomButtons()[0]!)
    expect(within(await viewer()).getAllByRole('img')).toHaveLength(1)
  })

  it('a double tap zooms the picture and a second one brings it back', async () => {
    await addPictures('i0')
    renderPresent()
    await openProduct()
    fireEvent.click(zoomButtons()[0]!)
    const dialog = within(await viewer())
    const picture = dialog.getByRole('img')
    const tap = () => {
      const area = picture.parentElement!
      fireEvent.pointerDown(area, { pointerId: 1, clientX: 50, clientY: 50 })
      fireEvent.pointerUp(area, { pointerId: 1, clientX: 50, clientY: 50 })
    }
    expect(picture.style.transform).toContain('scale(1)')
    tap()
    tap()
    await waitFor(() => expect(picture.style.transform).toContain('scale(2.5)'))
    tap()
    tap()
    await waitFor(() => expect(picture.style.transform).toContain('scale(1)'))
  })

  it('shows nothing private: no link, no shelf quantity, no balance', async () => {
    await addPictures('i0', 'i1')
    renderPresent()
    await openProduct()
    fireEvent.click(zoomButtons()[0]!)
    await viewer()
    expect(document.querySelectorAll('a')).toHaveLength(0)
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\b37\b/)
    expect(text).not.toContain(ar.customers.balance)
  })

  it('does not change what is stored: the pictures, the stock and the outbox are as they were', async () => {
    await addPictures('i0', 'i1')
    const snapshot = async () =>
      JSON.stringify([
        await db.images.toArray(),
        await db.variants.toArray(),
        await db.outbox.toArray(),
      ])
    const before = await snapshot()
    renderPresent()
    await openProduct()
    fireEvent.click(zoomButtons()[1]!)
    const dialog = within(await viewer())
    fireEvent.click(dialog.getByRole('button', { name: ar.present.prevPicture }))
    fireEvent.click(dialog.getByRole('button', { name: ar.present.close }))
    expect(await snapshot()).toBe(before)
  })
})
