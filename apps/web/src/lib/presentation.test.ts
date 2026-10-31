import { describe, expect, it } from 'vitest'
import type { DbImage, DbProduct, DbVariant, OutboxRow } from '../db'
import type { Snapshot } from './localCatalog'
import { availabilityOf, buildPresentCatalog } from './presentation'

const product = (id: string, name: string, extra: Partial<DbProduct> = {}): DbProduct => ({
  id,
  category_id: 'c1',
  name,
  description: `وصف ${name}`,
  search_text: name,
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
  min_stock: 3,
  stock_qty: 37,
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

const snapshot = (extra: Partial<Snapshot> = {}): Snapshot => ({
  categories: [
    { id: 'c1', name: 'أراجيل', sort_order: 0, is_active: true, change_seq: 1 },
    { id: 'c2', name: 'فحم', sort_order: 1, is_active: true, change_seq: 1 },
    { id: 'c3', name: 'قديمة', sort_order: 2, is_active: false, change_seq: 1 },
  ],
  products: [product('p1', 'أرجيلة'), product('p2', 'فحم طبيعي', { category_id: 'c2' })],
  variants: [variant('v1', 'p1', { color: 'أسود' }), variant('v2', 'p2')],
  images: [],
  pending: [],
  ...extra,
})

describe('availability badge', () => {
  it.each([
    [0, 3, 'unavailable'],
    [-2, 3, 'unavailable'],
    [3, 3, 'limited'],
    [1, 3, 'limited'],
    [4, 3, 'available'],
  ])('stock %i with alert level %i is %s', (qty, min, expected) => {
    expect(availabilityOf(qty, min)).toBe(expected)
  })
})

describe('presentation catalog', () => {
  it('lists categories that have something to show, with a cover and a count', () => {
    const s = snapshot({ images: [image('i1', 'p1'), image('i2', 'p2')] })
    const { categories } = buildPresentCatalog(s)
    expect(categories.map((c) => [c.name, c.count, c.cover])).toEqual([
      ['أراجيل', 1, '/media/i1-t.webp'],
      ['فحم', 1, '/media/i2-t.webp'],
    ])
  })

  it('hides out-of-stock variants by default, and a product with none left', () => {
    const s = snapshot()
    s.variants.push(variant('v3', 'p1', { color: 'أحمر', stock_qty: 0 }))
    s.variants[1] = variant('v2', 'p2', { stock_qty: 0 })
    const { products, categories } = buildPresentCatalog(s)
    expect(products.map((p) => p.id)).toEqual(['p1'])
    expect(products[0]?.variants.map((v) => v.id)).toEqual(['v1'])
    expect(categories.map((c) => c.id)).toEqual(['c1'])
  })

  it('can show out-of-stock items, marked unavailable and with nothing to add', () => {
    const s = snapshot()
    s.variants[0] = variant('v1', 'p1', { stock_qty: 0 })
    const { products } = buildPresentCatalog(s, { hideOutOfStock: false })
    const shown = products.find((p) => p.id === 'p1')
    expect(shown?.availability).toBe('unavailable')
    expect(shown?.variants[0]).toMatchObject({ availability: 'unavailable', available: 0 })
  })

  it('stock waiting on the device is counted: a sale in the outbox lowers what can be added', () => {
    const pending: OutboxRow[] = [
      {
        id: 'cmd',
        type: 'invoice.create',
        schema_version: 1,
        created_at: '2026-11-01T00:00:00Z',
        status: 'pending',
        payload: {
          invoice_id: 'i',
          number: 'INV-000001',
          customer_id: 'c',
          issued_at: '2026-11-01T00:00:00Z',
          discount: 0,
          note: null,
          payment: null,
          lines: [{ line_id: 'l', variant_id: 'v1', qty: 35, unit_price: 1000 }],
        },
      },
    ]
    const { products } = buildPresentCatalog(snapshot({ pending }))
    expect(products[0]?.variants[0]).toMatchObject({ available: 2, availability: 'limited' })
  })

  it('never shows stopped products, stopped variants or products of a stopped category', () => {
    const s = snapshot()
    s.products.push(product('p3', 'متوقف', { is_active: false }))
    s.products.push(product('p4', 'من فئة قديمة', { category_id: 'c3' }))
    s.variants.push(
      variant('v4', 'p3'),
      variant('v5', 'p4'),
      variant('v6', 'p1', { is_active: false }),
    )
    const { products } = buildPresentCatalog(s)
    expect(products.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
    expect(products.find((p) => p.id === 'p1')?.variants).toHaveLength(1)
  })

  it('searches with the same word match as the rep catalog', () => {
    expect(buildPresentCatalog(snapshot(), { q: 'فحم' }).products.map((p) => p.id)).toEqual(['p2'])
    expect(buildPresentCatalog(snapshot(), { q: 'لا شيء' }).products).toEqual([])
  })

  it('gives a price range, the whole-product images in order, and the variant picture', () => {
    const s = snapshot({
      images: [
        image('b', 'p1', { sort_order: 1 }),
        image('a', 'p1', { sort_order: 0 }),
        image('own', 'p1', { variant_id: 'v1' }),
        image('gone', 'p1', { deleted_at: '2026-11-01T00:00:00Z' }),
      ],
    })
    s.variants.push(variant('v7', 'p1', { color: 'ذهبي', price: 2500 }))
    const p = buildPresentCatalog(s).products.find((x) => x.id === 'p1')!
    expect([p.priceMin, p.priceMax]).toEqual([1000, 2500])
    expect(p.images.map((i) => i.id)).toEqual(['a', 'b'])
    expect(p.variants.find((v) => v.id === 'v1')?.image?.id).toBe('own')
    expect(p.thumb).toBe('/media/a-t.webp')
  })
})
