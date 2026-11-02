import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, wipeLocalData, type DbProduct, type DbVariant } from '../db'
import { ar } from '../i18n/ar'
import { useSync } from '../lib/sync/engine'
import { normalizeArabic } from '../lib/normalize'
import { readPerf } from '../lib/perf'
import { isCatalogPath, resetCatalogFilters } from '../lib/catalogFilters'
import { Catalog } from './Catalog'

// jsdom has no layout, so the real virtualizer would show no rows. The library is not what is tested
// here: this stand-in lists every row so the screen's own states and content can be checked.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 100,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 100 })),
    measureElement: () => undefined,
  }),
}))

const addProduct = async (
  n: number,
  variantExtra: Partial<DbVariant> = {},
  productExtra: Partial<DbProduct> = {},
) => {
  const name = `منتج ${n}`
  await db.products.put({
    id: `p${n}`,
    category_id: 'c1',
    name,
    description: null,
    search_text: normalizeArabic(`${name} أراجيل`),
    is_active: true,
    change_seq: 1,
    ...productExtra,
  })
  await db.variants.put({
    id: `v${n}`,
    product_id: `p${n}`,
    sku: `SKU-${n}`,
    color: null,
    size: null,
    price: 1000,
    min_stock: 2,
    stock_qty: 12,
    is_active: true,
    change_seq: 1,
    ...variantExtra,
  })
}

const renderCatalog = () =>
  render(
    <MemoryRouter>
      <Catalog />
    </MemoryRouter>,
  )

beforeEach(async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  await wipeLocalData()
  await db.categories.put({
    id: 'c1',
    name: 'أراجيل',
    sort_order: 0,
    is_active: true,
    change_seq: 1,
  })
  useSync.setState({ firstSyncDone: true })
  resetCatalogFilters()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Catalog screen (reads the device, not the network)', () => {
  it('shows a skeleton first and then the products with price and stock', async () => {
    await addProduct(1)
    await addProduct(2)
    const { container } = renderCatalog()
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(await screen.findByText('منتج 1')).toBeTruthy()
    expect(screen.getByText('منتج 2')).toBeTruthy()
    expect(screen.getAllByText(/1.?0\.00/).length).toBeGreaterThan(0)
  })

  it('reads products from the device: the only thing it asks the server for is what changed', async () => {
    const fetchStub = vi.fn<(url: string) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            changes: { categories: [], products: [], variants: [], images: [] },
            cursor: 0,
            has_more: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchStub)
    await addProduct(1)
    renderCatalog()
    await screen.findByText('منتج 1')
    await waitFor(() => expect(fetchStub).toHaveBeenCalled())
    for (const [url] of fetchStub.mock.calls) expect(String(url)).toContain('/sync/')
  })

  it('works offline: the same products are there', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    await addProduct(1)
    renderCatalog()
    expect(await screen.findByText('منتج 1')).toBeTruthy()
    expect(screen.queryByText(ar.needsInternet)).toBeNull()
  })

  it('marks low and out of stock with text, not only colour', async () => {
    await addProduct(1, { stock_qty: 1 }) // at or under the alert level of 2
    await addProduct(2, { stock_qty: 0 })
    renderCatalog()
    await screen.findByText('منتج 1')
    expect(screen.getByText(/1 منخفض/)).toBeTruthy()
    expect(screen.getByText(ar.status.out)).toBeTruthy()
  })

  it('counts stock waiting to be sent: a pending stock-in lifts "out" back to available', async () => {
    await addProduct(1, { stock_qty: 0 })
    await db.outbox.add({
      id: 'cmd1',
      type: 'stock.purchase',
      schema_version: 1,
      payload: { note: null, items: [{ movement_id: 'm', variant_id: 'v1', qty: 8 }] },
      created_at: '2026-11-01T00:00:00Z',
      status: 'pending',
    })
    renderCatalog()
    await screen.findByText('منتج 1')
    expect(screen.queryByText(ar.status.out)).toBeNull()
    expect(screen.getByText(/متوفر/)).toBeTruthy()
  })

  it('explains an empty catalog and links to the importer', async () => {
    renderCatalog()
    expect(await screen.findByText(ar.empty.catalog.title)).toBeTruthy()
    const link = screen.getByRole('link', { name: ar.empty.catalog.next })
    expect(link.getAttribute('href')).toBe('/settings/import')
  })

  it('says it is loading for the first time while nothing has been pulled yet', async () => {
    useSync.setState({ firstSyncDone: false })
    renderCatalog()
    expect(await screen.findByText(ar.catalog.firstSync)).toBeTruthy()
  })

  it('asks for the network once, on the very first start, when there is none', async () => {
    useSync.setState({ firstSyncDone: false })
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    renderCatalog()
    expect(await screen.findByText(ar.catalog.firstSyncOffline)).toBeTruthy()
  })

  it('searches with any spelling and says so when nothing matched', async () => {
    await addProduct(1)
    await db.products.put({
      id: 'pa',
      category_id: 'c1',
      name: 'أرجيلة كبيرة',
      description: null,
      search_text: normalizeArabic('أرجيلة كبيرة أراجيل'),
      is_active: true,
      change_seq: 1,
    })
    renderCatalog()
    await screen.findByText('منتج 1')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ارجيله' } })
    await waitFor(() => expect(screen.queryByText('منتج 1')).toBeNull())
    expect(screen.getByText('أرجيلة كبيرة')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'لا شيء' } })
    expect(await screen.findByText(ar.catalog.noResults)).toBeTruthy()
  })

  it('filters by category and can include stopped products', async () => {
    await db.categories.put({
      id: 'c2',
      name: 'فحم',
      sort_order: 1,
      is_active: true,
      change_seq: 1,
    })
    await addProduct(1)
    await addProduct(2, {}, { category_id: 'c2' })
    await addProduct(3, {}, { is_active: false })
    renderCatalog()
    await screen.findByText('منتج 1')
    expect(screen.queryByText('منتج 3')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'فحم' }))
    await waitFor(() => expect(screen.queryByText('منتج 1')).toBeNull())
    expect(screen.getByText('منتج 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: ar.catalog.all }))
    fireEvent.click(screen.getByRole('button', { name: ar.catalog.inactive }))
    expect(await screen.findByText('منتج 3')).toBeTruthy()
  })

  it('shows new products as soon as a pull writes them (live)', async () => {
    renderCatalog()
    await screen.findByText(ar.empty.catalog.title)
    await addProduct(7)
    expect(await screen.findByText('منتج 7')).toBeTruthy()
  })
})

describe('Catalog timing', () => {
  it('keeps how long it took to open, so Settings can show it', async () => {
    await addProduct(1)
    renderCatalog()
    await screen.findByText('منتج 1')
    await waitFor(async () => expect(typeof (await readPerf())?.catalogOpenMs).toBe('number'))
  })
})

describe('filters and order', () => {
  const names = () =>
    screen
      .getAllByRole('link')
      .map((a) => /منتج \d/.exec(a.textContent ?? '')?.[0])
      .filter(Boolean)

  const openFilters = async () => {
    await screen.findByText('منتج 1')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ar.catalog.filters) }))
    return within(await screen.findByLabelText(ar.catalog.filters))
  }

  beforeEach(async () => {
    await addProduct(1, { color: 'أسود', price: 3000, stock_qty: 20 })
    await addProduct(2, { color: 'أحمر', price: 1000, stock_qty: 0 })
    await addProduct(3, { color: 'أسود', price: 2000, stock_qty: 1, min_stock: 2 })
  })

  it('a colour chip narrows the list, the button counts it, and clearing brings everything back', async () => {
    renderCatalog()
    const panel = await openFilters()
    fireEvent.click(panel.getByRole('button', { name: 'أحمر' }))
    await waitFor(() => expect(names()).toEqual(['منتج 2']))
    expect(screen.getByRole('button', { name: /الفلاتر \(1\)/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ar.catalog.clearFilters) }))
    await waitFor(() => expect(names()).toHaveLength(3))
  })

  it('availability and price range combine with the colour', async () => {
    renderCatalog()
    const panel = await openFilters()
    fireEvent.click(panel.getByRole('button', { name: 'أسود' }))
    fireEvent.click(panel.getByRole('button', { name: new RegExp(ar.status.low) }))
    await waitFor(() => expect(names()).toEqual(['منتج 3']))
    fireEvent.click(panel.getByRole('button', { name: new RegExp(ar.status.low) })) // off again
    fireEvent.change(panel.getByLabelText(ar.catalog.priceFrom), { target: { value: '٢٥' } })
    await waitFor(() => expect(names()).toEqual(['منتج 1']))
    fireEvent.change(panel.getByLabelText(ar.catalog.priceFrom), { target: { value: '' } })
    fireEvent.change(panel.getByLabelText(ar.catalog.priceTo), { target: { value: '15' } })
    await waitFor(() => expect(screen.queryByText('منتج 1')).toBeNull())
    expect(screen.queryByText('منتج 3')).toBeNull()
  })

  it('a price that is not a number is said so and changes nothing', async () => {
    renderCatalog()
    const panel = await openFilters()
    fireEvent.change(panel.getByLabelText(ar.catalog.priceFrom), { target: { value: 'abc' } })
    expect(await panel.findByText(ar.catalog.badPriceRange)).toBeTruthy()
    expect(names()).toHaveLength(3)
  })

  it('sorts by price both ways', async () => {
    renderCatalog()
    const panel = await openFilters()
    const sort = panel.getByLabelText(ar.catalog.sort)
    fireEvent.change(sort, { target: { value: 'price_low' } })
    await waitFor(() => expect(names()).toEqual(['منتج 2', 'منتج 3', 'منتج 1']))
    fireEvent.change(sort, { target: { value: 'price_high' } })
    await waitFor(() => expect(names()).toEqual(['منتج 1', 'منتج 3', 'منتج 2']))
  })

  it('best-selling counts the last 90 days of confirmed invoices only', async () => {
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString()
    const invoice = (id: string, issued: string, status: 'confirmed' | 'cancelled') => ({
      id,
      number: id,
      customer_id: 'c',
      status,
      subtotal: 0,
      discount: 0,
      total: 0,
      note: null,
      issued_at: issued,
      delivered_at: null,
      cancelled_at: null,
      cancel_reason: null,
      change_seq: 1,
    })
    const line = (id: string, invoiceId: string, variantId: string, qty: number) => ({
      id,
      invoice_id: invoiceId,
      variant_id: variantId,
      product_name: '',
      variant_label: '',
      qty,
      unit_price: 0,
      line_total: 0,
      discount_share: 0,
      sort_order: 0,
      change_seq: 1,
    })
    await db.invoices.bulkPut([
      invoice('i1', day(10), 'confirmed'),
      invoice('i2', day(100), 'confirmed'), // too old
      invoice('i3', day(5), 'cancelled'), // cancelled
    ])
    await db.invoice_lines.bulkPut([
      line('l1', 'i1', 'v3', 4),
      line('l2', 'i1', 'v1', 1),
      line('l3', 'i2', 'v2', 50),
      line('l4', 'i3', 'v2', 50),
    ])
    renderCatalog()
    const panel = await openFilters()
    fireEvent.change(panel.getByLabelText(ar.catalog.sort), { target: { value: 'bestselling' } })
    await waitFor(() => expect(names()).toEqual(['منتج 3', 'منتج 1', 'منتج 2']))
  })

  it('the filters are still there when the catalog is opened again, until they are reset', async () => {
    const first = renderCatalog()
    const panel = await openFilters()
    fireEvent.click(panel.getByRole('button', { name: 'أحمر' }))
    await waitFor(() => expect(names()).toEqual(['منتج 2']))
    first.unmount()
    renderCatalog()
    await waitFor(() => expect(names()).toEqual(['منتج 2']))
    cleanup()
    resetCatalogFilters() // what leaving the catalog does
    renderCatalog()
    await waitFor(() => expect(names()).toHaveLength(3))
  })

  it('only the catalog and a product page count as the catalog', () => {
    expect(['/catalog', '/catalog/abc'].every(isCatalogPath)).toBe(true)
    expect(['/', '/customers', '/present', '/catalogue'].some(isCatalogPath)).toBe(false)
  })

  it('searching says which variants matched and opens the product on them', async () => {
    await db.products.put({
      id: 'p9',
      category_id: 'c1',
      name: 'بربيش',
      description: null,
      search_text: '',
      is_active: true,
      change_seq: 1,
    })
    await db.variants.bulkPut(
      [
        ['v9a', 'أسود'],
        ['v9b', 'أخضر'],
      ].map(([id, color]) => ({
        id: id!,
        product_id: 'p9',
        sku: `SKU-${id}`,
        color: color!,
        size: null,
        price: 500,
        min_stock: 1,
        stock_qty: 9,
        is_active: true,
        change_seq: 1,
      })),
    )
    renderCatalog()
    await screen.findByText('منتج 1')
    fireEvent.change(screen.getByRole('searchbox', { name: ar.catalog.search }), {
      target: { value: 'بربيش اسود' },
    })
    const link = await screen.findByRole('link', { name: /بربيش/ })
    expect(link.textContent).toContain('مطابق: أسود')
    expect(link.getAttribute('href')).toBe('/catalog/p9?hl=v9a')
  })
})
