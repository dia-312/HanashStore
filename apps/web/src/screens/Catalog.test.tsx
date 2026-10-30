import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ar } from '../i18n/ar'
import type { ProductListItem } from '../lib/catalogApi'
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

const product = (n: number, extra: Partial<ProductListItem> = {}): ProductListItem => ({
  id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  name: `منتج ${n}`,
  category_id: 'c1',
  category_name: 'أراجيل',
  is_active: true,
  thumb_url: null,
  variant_count: 2,
  price_min: 1000,
  price_max: 2500,
  stock_total: 12,
  low_count: 0,
  out_count: 0,
  ...extra,
})

function stubApi(products: (url: URL) => ProductListItem[] | Error) {
  const calls: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost')
      calls.push(url)
      const body = url.pathname.endsWith('/categories')
        ? [{ id: 'c1', name: 'أراجيل', sort_order: 0, is_active: true, product_count: 2 }]
        : (() => {
            const result = products(url)
            if (result instanceof Error) throw result
            return { items: result, next_cursor: null }
          })()
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return calls
}

const renderCatalog = () =>
  render(
    <MemoryRouter>
      <Catalog />
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Catalog screen', () => {
  it('shows a skeleton first and then the products with price range and stock', async () => {
    stubApi(() => [product(1), product(2, { low_count: 1 }), product(3, { out_count: 2 })])
    const { container } = renderCatalog()
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(await screen.findByText('منتج 1')).toBeTruthy()
    expect(screen.getAllByText(/1.?0\.00/).length).toBeGreaterThan(0)
  })

  it('marks low and out of stock with text, not only colour', async () => {
    stubApi(() => [product(1, { low_count: 1 }), product(2, { out_count: 2 })])
    renderCatalog()
    await screen.findByText('منتج 1')
    expect(screen.getByText(/1 منخفض/)).toBeTruthy()
    expect(screen.getByText(ar.status.out)).toBeTruthy()
  })

  it('explains an empty catalog and links to the importer', async () => {
    stubApi(() => [])
    renderCatalog()
    expect(await screen.findByText(ar.empty.catalog.title)).toBeTruthy()
    const link = screen.getByRole('link', { name: ar.empty.catalog.next })
    expect(link.getAttribute('href')).toBe('/settings/import')
  })

  it('says nothing matched when a search finds nothing', async () => {
    const calls = stubApi((url) => (url.searchParams.get('q') ? [] : [product(1)]))
    renderCatalog()
    await screen.findByText('منتج 1')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'لا شيء' } })
    expect(await screen.findByText(ar.catalog.noResults)).toBeTruthy()
    expect(calls.some((url) => url.searchParams.get('q') === 'لا شيء')).toBe(true)
  })

  it('filters by category and can include stopped products', async () => {
    const calls = stubApi(() => [product(1)])
    renderCatalog()
    await screen.findByText('منتج 1')
    fireEvent.click(await screen.findByRole('button', { name: 'أراجيل' }))
    await waitFor(() =>
      expect(calls.some((u) => u.searchParams.get('category_id') === 'c1')).toBe(true),
    )
    fireEvent.click(screen.getByRole('button', { name: ar.catalog.inactive }))
    await waitFor(() =>
      expect(calls.some((u) => u.searchParams.get('include_inactive') === 'true')).toBe(true),
    )
  })

  it('offers a retry when loading fails', async () => {
    stubApi(() => new Error('down'))
    renderCatalog()
    expect(await screen.findByText(ar.catalog.loadFailed)).toBeTruthy()
    expect(screen.getByRole('button', { name: ar.form.retry })).toBeTruthy()
  })

  it('does not call the API while offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    const calls = stubApi(() => [product(1)])
    renderCatalog()
    expect(await screen.findByText(ar.needsInternet)).toBeTruthy()
    expect(calls.filter((u) => u.pathname.endsWith('/products'))).toHaveLength(0)
  })
})
