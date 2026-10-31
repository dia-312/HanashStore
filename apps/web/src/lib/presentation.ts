import type { DbImage } from '../db'
import { matchesSearch, stockStatus, type Snapshot } from './localCatalog'
import { pendingStock } from './sync/effectiveStock'

// What presentation mode may show (SPEC section 10): names, images, descriptions, prices, colours
// and sizes, and availability as a badge. The exact quantity never leaves this module: `available`
// is only used to bound the stepper and to pick the badge.

export type Availability = 'available' | 'limited' | 'unavailable'

export interface PresentVariant {
  id: string
  color: string | null
  size: string | null
  price: number
  availability: Availability
  /** How many can still be added: the stock on the shelf (this device's view). Never displayed. */
  available: number
  image: DbImage | null
}

export interface PresentProduct {
  id: string
  name: string
  description: string | null
  category_id: string
  thumb: string | null
  images: DbImage[]
  priceMin: number
  priceMax: number
  availability: Availability
  variants: PresentVariant[]
}

export interface PresentCategory {
  id: string
  name: string
  cover: string | null
  count: number
}

export interface PresentCatalog {
  categories: PresentCategory[]
  products: PresentProduct[]
}

const RANK: Record<Availability, number> = { available: 2, limited: 1, unavailable: 0 }

export function availabilityOf(qty: number, minStock: number): Availability {
  const status = stockStatus(qty, minStock)
  return status === 'out' ? 'unavailable' : status === 'low' ? 'limited' : 'available'
}

export function buildPresentCatalog(
  s: Snapshot,
  options: { q?: string; hideOutOfStock?: boolean } = {},
): PresentCatalog {
  const hideOut = options.hideOutOfStock ?? true
  const effective = pendingStock(new Map(s.variants.map((v) => [v.id, v.stock_qty])), s.pending)
  const activeCategories = new Map(s.categories.filter((c) => c.is_active).map((c) => [c.id, c]))
  const images = new Map<string, DbImage[]>()
  for (const image of s.images) {
    if (image.deleted_at !== null) continue
    images.set(image.product_id, [...(images.get(image.product_id) ?? []), image])
  }
  for (const list of images.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
  }

  const products: PresentProduct[] = []
  for (const p of s.products) {
    if (!p.is_active || !activeCategories.has(p.category_id)) continue
    if (options.q && !matchesSearch(p.search_text, options.q)) continue
    const productImages = images.get(p.id) ?? []
    const variants: PresentVariant[] = s.variants
      .filter((v) => v.product_id === p.id && v.is_active)
      .sort((a, b) => a.sku.localeCompare(b.sku))
      .map((v) => {
        const qty = effective.get(v.id) ?? v.stock_qty
        return {
          id: v.id,
          color: v.color,
          size: v.size,
          price: v.price,
          availability: availabilityOf(qty, v.min_stock),
          available: Math.max(qty, 0),
          image: productImages.find((i) => i.variant_id === v.id) ?? null,
        }
      })
      .filter((v) => !hideOut || v.availability !== 'unavailable')
    if (variants.length === 0) continue
    const best = variants.reduce<Availability>(
      (acc, v) => (RANK[v.availability] > RANK[acc] ? v.availability : acc),
      'unavailable',
    )
    const wholeProduct = productImages.filter((i) => i.variant_id === null)
    products.push({
      id: p.id,
      name: p.name,
      description: p.description,
      category_id: p.category_id,
      thumb: wholeProduct[0]?.thumb_url ?? null,
      images: wholeProduct,
      priceMin: Math.min(...variants.map((v) => v.price)),
      priceMax: Math.max(...variants.map((v) => v.price)),
      availability: best,
      variants,
    })
  }
  const collator = new Intl.Collator('ar')
  products.sort((a, b) => collator.compare(a.name, b.name))

  const categories: PresentCategory[] = []
  for (const category of [...activeCategories.values()].sort(
    (a, b) => a.sort_order - b.sort_order || collator.compare(a.name, b.name),
  )) {
    const inCategory = products.filter((p) => p.category_id === category.id)
    if (inCategory.length === 0) continue
    categories.push({
      id: category.id,
      name: category.name,
      cover: inCategory.find((p) => p.thumb)?.thumb ?? null,
      count: inCategory.length,
    })
  }
  return { categories, products }
}
