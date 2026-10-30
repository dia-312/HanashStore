import {
  db,
  type DbCategory,
  type DbImage,
  type DbProduct,
  type DbVariant,
  type OutboxRow,
} from '../db'
import type {
  Category,
  ProductDetail,
  ProductListItem,
  StockStatus,
  Variant,
  VariantListItem,
} from './catalogApi'
import { normalizeArabic } from './normalize'
import { pendingStock } from './sync/effectiveStock'

/** Out = nothing left; low = at or under the alert level (SPEC section 4, F3). */
export function stockStatus(qty: number, minStock: number): StockStatus {
  if (qty <= 0) return 'out'
  return qty <= minStock ? 'low' : 'ok'
}

/** Everything a screen needs, read from the device. The builders below are plain functions of it. */
export interface Snapshot {
  categories: DbCategory[]
  products: DbProduct[]
  variants: DbVariant[]
  images: DbImage[]
  pending: OutboxRow[]
}

export async function loadSnapshot(): Promise<Snapshot> {
  const [categories, products, variants, images, pending] = await Promise.all([
    db.categories.toArray(),
    db.products.toArray(),
    db.variants.toArray(),
    db.images.toArray(),
    db.outbox.where('status').equals('pending').sortBy('seq'),
  ])
  return { categories, products, variants, images, pending }
}

export async function loadProductSnapshot(productId: string): Promise<Snapshot> {
  const [products, variants, images, pending] = await Promise.all([
    db.products.where('id').equals(productId).toArray(),
    db.variants.where('product_id').equals(productId).toArray(),
    db.images.where('product_id').equals(productId).toArray(),
    db.outbox.where('status').equals('pending').sortBy('seq'),
  ])
  const categories = products[0]
    ? await db.categories.where('id').equals(products[0].category_id).toArray()
    : []
  return { categories, products, variants, images, pending }
}

const collator = new Intl.Collator('ar')

/** Variants with the quantity the rep should see: the server's plus the commands still waiting. */
function withEffectiveStock(s: Snapshot): (DbVariant & { status: StockStatus })[] {
  const effective = pendingStock(new Map(s.variants.map((v) => [v.id, v.stock_qty])), s.pending)
  return s.variants.map((v) => {
    const stock_qty = effective.get(v.id) ?? v.stock_qty
    return { ...v, stock_qty, status: stockStatus(stock_qty, v.min_stock) }
  })
}

/** The first image that belongs to the whole product, in the order the rep arranged them. */
function thumbsByProduct(images: DbImage[]): Map<string, string> {
  const best = new Map<string, DbImage>()
  for (const image of images) {
    if (image.deleted_at !== null || image.variant_id !== null) continue
    const current = best.get(image.product_id)
    if (!current || image.sort_order < current.sort_order) best.set(image.product_id, image)
  }
  return new Map([...best].map(([id, image]) => [id, image.thumb_url]))
}

/** Every typed word must appear in the product's normalized search text (SPEC section 9 basics). */
export function matchesSearch(searchText: string, query: string): boolean {
  const tokens = normalizeArabic(query).split(' ').filter(Boolean)
  return tokens.every((token) => searchText.includes(token))
}

export interface ProductFilter {
  q?: string
  categoryId?: string
  includeInactive?: boolean
}

export function buildProductList(s: Snapshot, filter: ProductFilter = {}): ProductListItem[] {
  const categoryNames = new Map(s.categories.map((c) => [c.id, c.name]))
  const thumbs = thumbsByProduct(s.images)
  const byProduct = new Map<string, ReturnType<typeof withEffectiveStock>>()
  for (const v of withEffectiveStock(s)) {
    if (!v.is_active) continue // like the server: stopped variants don't count in the totals
    const list = byProduct.get(v.product_id) ?? []
    list.push(v)
    byProduct.set(v.product_id, list)
  }
  const items: ProductListItem[] = []
  for (const p of s.products) {
    if (!p.is_active && !filter.includeInactive) continue
    if (filter.categoryId && p.category_id !== filter.categoryId) continue
    if (filter.q && !matchesSearch(p.search_text, filter.q)) continue
    const variants = byProduct.get(p.id) ?? []
    items.push({
      id: p.id,
      name: p.name,
      category_id: p.category_id,
      category_name: categoryNames.get(p.category_id) ?? '',
      is_active: p.is_active,
      thumb_url: thumbs.get(p.id) ?? null,
      variant_count: variants.length,
      price_min: variants.length ? Math.min(...variants.map((v) => v.price)) : null,
      price_max: variants.length ? Math.max(...variants.map((v) => v.price)) : null,
      stock_total: variants.reduce((sum, v) => sum + v.stock_qty, 0),
      low_count: variants.filter((v) => v.stock_qty > 0 && v.stock_qty <= v.min_stock).length,
      out_count: variants.filter((v) => v.stock_qty <= 0).length,
    })
  }
  return items.sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id))
}

export function buildCategories(s: Snapshot): Category[] {
  const counts = new Map<string, number>()
  for (const p of s.products)
    if (p.is_active) counts.set(p.category_id, (counts.get(p.category_id) ?? 0) + 1)
  return s.categories
    .filter((c) => c.is_active)
    .map((c) => ({ ...c, product_count: counts.get(c.id) ?? 0 }))
    .sort((a, b) => a.sort_order - b.sort_order || collator.compare(a.name, b.name))
}

export function buildProductDetail(s: Snapshot, productId: string): ProductDetail | null {
  const product = s.products.find((p) => p.id === productId)
  if (!product) return null
  const variants: Variant[] = withEffectiveStock(s)
    .filter((v) => v.product_id === productId)
    .sort((a, b) => a.sku.localeCompare(b.sku))
  return {
    id: product.id,
    name: product.name,
    category_id: product.category_id,
    category_name: s.categories.find((c) => c.id === product.category_id)?.name ?? '',
    description: product.description,
    is_active: product.is_active,
    images: s.images
      .filter((i) => i.product_id === productId && i.deleted_at === null)
      .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)),
    variants,
  }
}

/** Active variants of active products, for pickers such as stock-in. */
export function buildVariantList(s: Snapshot, q = ''): VariantListItem[] {
  const products = new Map(s.products.map((p) => [p.id, p]))
  const thumbs = thumbsByProduct(s.images)
  const items: VariantListItem[] = []
  for (const v of withEffectiveStock(s)) {
    const product = products.get(v.product_id)
    if (!v.is_active || !product || !product.is_active) continue
    if (q && !matchesSearch(product.search_text, q)) continue
    items.push({
      id: v.id,
      product_id: v.product_id,
      product_name: product.name,
      sku: v.sku,
      color: v.color,
      size: v.size,
      price: v.price,
      min_stock: v.min_stock,
      stock_qty: v.stock_qty,
      status: v.status,
      thumb_url: thumbs.get(v.product_id) ?? null,
    })
  }
  return items.sort(
    (a, b) => collator.compare(a.product_name, b.product_name) || a.sku.localeCompare(b.sku),
  )
}
