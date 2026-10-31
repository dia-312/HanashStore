import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, wipeLocalData, type DbProduct, type DbVariant } from '../db'
import { ar } from '../i18n/ar'
import { useSync } from '../lib/sync/engine'
import { normalizeArabic } from '../lib/normalize'
import { readPerf } from '../lib/perf'
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
