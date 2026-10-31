import { describe, expect, it } from 'vitest'
import type { DbImage, DbProduct, DbVariant, OutboxRow } from '../db'
import {
  buildCategories,
  buildProductDetail,
  buildProductList,
  buildVariantList,
  matchesSearch,
  stockStatus,
  type Snapshot,
} from './localCatalog'
import { normalizeArabic } from './normalize'

const product = (id: string, name: string, extra: Partial<DbProduct> = {}): DbProduct => ({
  id,
  category_id: 'c1',
  name,
  description: null,
  search_text: normalizeArabic(`${name} أراجيل`),
  is_active: true,
  change_seq: 1,
  ...extra,
})

const variant = (id: string, productId: string, extra: Partial<DbVariant> = {}): DbVariant => ({
  id,
  product_id: productId,
  sku: `SKU-${id}`,
  color: null,
  size: null,
  price: 1000,
  min_stock: 2,
  stock_qty: 10,
  is_active: true,
  change_seq: 1,
  ...extra,
})

const image = (id: string, productId: string, extra: Partial<DbImage> = {}): DbImage => ({
  id,
  product_id: productId,
  variant_id: null,
  thumb_url: `/media/${id}-t.webp`,
  full_url: `/media/${id}-f.webp`,
  sort_order: 0,
  deleted_at: null,
  change_seq: 1,
  ...extra,
})

const pending = (type: string, payload: unknown): OutboxRow => ({
  id: crypto.randomUUID(),
  type,
  payload,
  schema_version: 1,
  created_at: '2026-11-01T00:00:00Z',
  status: 'pending',
})

const snapshot = (extra: Partial<Snapshot> = {}): Snapshot => ({
  categories: [
    { id: 'c1', name: 'أراجيل', sort_order: 0, is_active: true, change_seq: 1 },
    { id: 'c2', name: 'فحم', sort_order: 1, is_active: true, change_seq: 1 },
    { id: 'c3', name: 'قديمة', sort_order: 2, is_active: false, change_seq: 1 },
  ],
  products: [product('p1', 'أرجيلة كبيرة'), product('p2', 'فحم طبيعي', { category_id: 'c2' })],
  variants: [
    variant('v1', 'p1', { price: 4500, stock_qty: 10 }),
    variant('v2', 'p1', { price: 5500, stock_qty: 0 }),
    variant('v3', 'p2', { price: 2000, stock_qty: 1, min_stock: 5 }),
  ],
  images: [],
  pending: [],
  ...extra,
})

describe('stockStatus', () => {
  it.each([
    [0, 5, 'out'],
    [-1, 5, 'out'],
    [3, 5, 'low'],
    [5, 5, 'low'],
    [6, 5, 'ok'],
    [1, 0, 'ok'],
  ])('%i with alert level %i is %s', (qty, min, expected) => {
    expect(stockStatus(qty, min)).toBe(expected)
  })
})

describe('search', () => {
  it('matches every typed word against the normalized text, whatever the spelling', () => {
    const text = normalizeArabic('أرجيلة كبيرة أراجيل')
    expect(matchesSearch(text, 'ارجيله')).toBe(true)
    expect(matchesSearch(text, 'كبيره ارجيله')).toBe(true)
    expect(matchesSearch(text, 'فحم')).toBe(false)
    expect(matchesSearch(text, '   ')).toBe(true) // nothing typed: everything matches
  })
})

describe('product list', () => {
  it('shows price range, stock total and low / out counts from the active variants', () => {
    const [shisha, coal] = buildProductList(snapshot())
    expect(shisha).toMatchObject({
      name: 'أرجيلة كبيرة',
      category_name: 'أراجيل',
      variant_count: 2,
      price_min: 4500,
      price_max: 5500,
      stock_total: 10,
      out_count: 1,
      low_count: 0,
    })
    expect(coal).toMatchObject({ low_count: 1, out_count: 0, stock_total: 1 })
  })

  it('a stopped variant does not count, like on the server', () => {
    const s = snapshot()
    s.variants[1] = variant('v2', 'p1', { is_active: false, price: 99999, stock_qty: 0 })
    const [shisha] = buildProductList(s)
    expect([shisha?.variant_count, shisha?.price_max, shisha?.out_count]).toEqual([1, 4500, 0])
  })

  it('stock waiting in the outbox is counted: a stock-in lifts a product out of "out"', () => {
    const s = snapshot({
      pending: [
        pending('stock.purchase', {
          note: null,
          items: [{ movement_id: 'm', variant_id: 'v2', qty: 6 }],
        }),
      ],
    })
    const [shisha] = buildProductList(s)
    expect([shisha?.out_count, shisha?.stock_total]).toEqual([0, 16])
  })

  it('filters by category, by search words, and hides stopped products unless asked', () => {
    const s = snapshot()
    s.products[1] = product('p2', 'فحم طبيعي', { category_id: 'c2', is_active: false })
    expect(buildProductList(s).map((p) => p.id)).toEqual(['p1'])
    expect(buildProductList(s, { includeInactive: true })).toHaveLength(2)
    expect(buildProductList(s, { categoryId: 'c2' })).toHaveLength(0)
    expect(buildProductList(s, { q: 'ارجيله' }).map((p) => p.id)).toEqual(['p1'])
    expect(buildProductList(s, { q: 'لا يوجد' })).toHaveLength(0)
  })

  it('uses the first whole-product image that is not deleted, in the rep order', () => {
    const s = snapshot({
      images: [
        image('a', 'p1', { sort_order: 2 }),
        image('b', 'p1', { sort_order: 1 }),
        image('c', 'p1', { sort_order: 0, deleted_at: '2026-11-01T00:00:00Z' }),
        image('d', 'p1', { sort_order: 0, variant_id: 'v1' }),
      ],
    })
    expect(buildProductList(s)[0]?.thumb_url).toBe('/media/b-t.webp')
    expect(buildProductList(s)[1]?.thumb_url).toBeNull()
  })

  it('a product with no variants says so instead of showing a price', () => {
    const s = snapshot({ variants: [] })
    expect(buildProductList(s)[0]).toMatchObject({ variant_count: 0, price_min: null })
  })

  it('sorts names the Arabic way', () => {
    const s = snapshot({
      products: [product('p1', 'ب'), product('p2', 'أ'), product('p3', 'ت')],
      variants: [],
    })
    expect(buildProductList(s).map((p) => p.name)).toEqual(['أ', 'ب', 'ت'])
  })
})

describe('categories and product detail', () => {
  it('lists only active categories, with how many active products each has', () => {
    const list = buildCategories(snapshot())
    expect(list.map((c) => [c.name, c.product_count])).toEqual([
      ['أراجيل', 1],
      ['فحم', 1],
    ])
  })

  it('product detail carries variants in SKU order with the shown stock and status', () => {
    const detail = buildProductDetail(
      snapshot({
        pending: [
          pending('stock.damage', {
            movement_id: 'm',
            variant_id: 'v1',
            qty: 9,
            note: 'x',
          }),
        ],
        images: [image('a', 'p1'), image('gone', 'p1', { deleted_at: '2026-11-01T00:00:00Z' })],
      }),
      'p1',
    )
    expect(detail?.category_name).toBe('أراجيل')
    expect(detail?.variants.map((v) => [v.sku, v.stock_qty, v.status])).toEqual([
      ['SKU-v1', 1, 'low'],
      ['SKU-v2', 0, 'out'],
    ])
    expect(detail?.images.map((i) => i.id)).toEqual(['a'])
  })

  it('an unknown product is null', () => {
    expect(buildProductDetail(snapshot(), 'nope')).toBeNull()
  })
})

describe('variant picker list', () => {
  it('lists active variants of active products with the shown stock', () => {
    const s = snapshot()
    s.variants.push(variant('v4', 'p1', { is_active: false }))
    s.products[1] = product('p2', 'فحم طبيعي', { category_id: 'c2', is_active: false })
    const items = buildVariantList(s)
    expect(items.map((i) => i.sku)).toEqual(['SKU-v1', 'SKU-v2'])
  })

  it('searches by the same words as the catalog and carries the thumbnail', () => {
    const s = snapshot({ images: [image('a', 'p2')] })
    const items = buildVariantList(s, 'فحم')
    expect(items.map((i) => i.id)).toEqual(['v3'])
    expect(items[0]?.thumb_url).toBe('/media/a-t.webp')
  })
})
