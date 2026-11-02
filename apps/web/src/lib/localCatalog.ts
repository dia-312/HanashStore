import {
  db,
  type DbCategory,
  type DbImage,
  type DbProduct,
  type DbSynonymGroup,
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
import { searchFor, type SearchHit } from './search'
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
  /** The groups of words that mean the same for search; none = no synonyms. */
  synonyms?: DbSynonymGroup[]
}

export async function loadSnapshot(): Promise<Snapshot> {
  const [categories, products, variants, images, pending, synonyms] = await Promise.all([
    db.categories.toArray(),
    db.products.toArray(),
    db.variants.toArray(),
    db.images.toArray(),
    db.outbox.where('status').equals('pending').sortBy('seq'),
    db.synonym_groups.toArray(),
  ])
  return { categories, products, variants, images, pending, synonyms }
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

/** The search engine for this snapshot: rebuilt only when the words in it change (see `searchFor`). */
export function searchHits(s: Snapshot, query: string): SearchHit[] {
  return searchFor({
    categories: s.categories,
    products: s.products,
    variants: s.variants,
    synonyms: s.synonyms,
  }).search(query)
}

export type SortKey = 'relevance' | 'name' | 'bestselling' | 'newest' | 'price_low' | 'price_high'

export interface ProductFilter {
  q?: string
  categoryId?: string
  includeInactive?: boolean
  /** Variant filters: a product is listed when at least one of its variants fits all of them. */
  color?: string
  size?: string
  availability?: StockStatus
  /** Agorot, inclusive. */
  priceMin?: number
  priceMax?: number
  sort?: SortKey
  /** Units sold in the last 90 days per product, for the best-selling order. */
  sold?: Map<string, number>
}

const hasVariantFilter = (f: ProductFilter) =>
  f.color !== undefined ||
  f.size !== undefined ||
  f.availability !== undefined ||
  f.priceMin !== undefined ||
  f.priceMax !== undefined

const variantLabel = (v: Pick<DbVariant, 'color' | 'size'>) =>
  [v.color, v.size].filter(Boolean).join(' · ')

type ListItem = ProductListItem & { score: number }

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
  const query = filter.q?.trim() ?? ''
  const hits = query ? new Map(searchHits(s, query).map((h) => [h.productId, h])) : null
  const variantFiltered = hasVariantFilter(filter)
  const fits = (v: ReturnType<typeof withEffectiveStock>[number], hit: SearchHit | undefined) =>
    (!hit || hit.variantIds.length === 0 || hit.variantIds.includes(v.id)) &&
    (filter.color === undefined || v.color === filter.color) &&
    (filter.size === undefined || v.size === filter.size) &&
    (filter.availability === undefined || v.status === filter.availability) &&
    (filter.priceMin === undefined || v.price >= filter.priceMin) &&
    (filter.priceMax === undefined || v.price <= filter.priceMax)

  const items: ListItem[] = []
  for (const p of s.products) {
    if (!p.is_active && !filter.includeInactive) continue
    if (filter.categoryId && p.category_id !== filter.categoryId) continue
    const hit = hits?.get(p.id)
    if (hits && !hit) continue
    const variants = byProduct.get(p.id) ?? []
    const matched = variants.filter((v) => fits(v, hit))
    if (variantFiltered && matched.length === 0) continue
    // Only worth pointing out when the words or filters picked some of the variants, not all.
    const pointOut = matched.length > 0 && matched.length < variants.length
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
      matched_variants: pointOut ? matched.map((v) => ({ id: v.id, label: variantLabel(v) })) : [],
      score: hit?.score ?? 0,
    })
  }
  const byName = (a: ListItem, b: ListItem) =>
    collator.compare(a.name, b.name) || a.id.localeCompare(b.id)
  const sold = (item: ListItem) => filter.sold?.get(item.id) ?? 0
  const order: Record<SortKey, (a: ListItem, b: ListItem) => number> = {
    relevance: (a, b) => b.score - a.score || byName(a, b),
    name: byName,
    // Product ids are time-ordered (UUIDv7): a larger id was made later.
    newest: (a, b) => b.id.localeCompare(a.id),
    bestselling: (a, b) => sold(b) - sold(a) || byName(a, b),
    price_low: (a, b) => (a.price_min ?? Infinity) - (b.price_min ?? Infinity) || byName(a, b),
    price_high: (a, b) => (b.price_max ?? -Infinity) - (a.price_max ?? -Infinity) || byName(a, b),
  }
  return items.sort(order[filter.sort ?? 'relevance']).map((item) => {
    const { score, ...rest } = item
    void score
    return rest
  })
}

/** What the filter chips can offer: the colours and sizes that exist on active variants. */
export function buildFacets(s: Snapshot): { colors: string[]; sizes: string[] } {
  const live = new Set(s.products.filter((p) => p.is_active).map((p) => p.id))
  const colors = new Set<string>()
  const sizes = new Set<string>()
  for (const v of s.variants) {
    if (!v.is_active || !live.has(v.product_id)) continue
    if (v.color) colors.add(v.color)
    if (v.size) sizes.add(v.size)
  }
  const natural = new Intl.Collator('ar', { numeric: true })
  return {
    colors: [...colors].sort(collator.compare),
    sizes: [...sizes].sort(natural.compare),
  }
}

const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000

/** Units sold per product over the last 90 days (cancelled invoices don't count). */
export async function loadSoldQty(now = Date.now()): Promise<Map<string, number>> {
  const since = new Date(now - NINETY_DAYS).toISOString()
  const invoices = (await db.invoices.where('issued_at').aboveOrEqual(since).toArray()).filter(
    (i) => i.status === 'confirmed',
  )
  const [lines, variants] = await Promise.all([
    db.invoice_lines
      .where('invoice_id')
      .anyOf(invoices.map((i) => i.id))
      .toArray(),
    db.variants.toArray(),
  ])
  const productOf = new Map(variants.map((v) => [v.id, v.product_id]))
  const sold = new Map<string, number>()
  for (const line of lines) {
    const productId = productOf.get(line.variant_id)
    if (productId) sold.set(productId, (sold.get(productId) ?? 0) + line.qty)
  }
  return sold
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
  const found = q.trim() ? new Set(searchHits(s, q).flatMap((h) => h.variantIds)) : null
  for (const v of withEffectiveStock(s)) {
    const product = products.get(v.product_id)
    if (!v.is_active || !product || !product.is_active) continue
    if (found && !found.has(v.id)) continue
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
