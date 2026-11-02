import MiniSearch, { type Query } from 'minisearch'
import type { DbCategory, DbProduct, DbSynonymGroup, DbVariant } from '../db'
import { normalizeArabic } from './normalize'

// Arabic search (SPEC section 9). One document per active variant, made of the normalized product
// name, category, colour, size, SKU and description, so "black hose" finds the black variants and
// not a product that has a black one and a red one in different places. Every typed word must be
// found (AND), as a prefix, with one typo allowed on words of 4+ characters, and each word also
// stands for the other words of its synonym groups. An exact SKU always comes first.

export interface SearchInput {
  categories: Pick<DbCategory, 'id' | 'name'>[]
  products: Pick<DbProduct, 'id' | 'category_id' | 'name' | 'description'>[]
  variants: Pick<DbVariant, 'id' | 'product_id' | 'sku' | 'color' | 'size' | 'is_active'>[]
  synonyms?: Pick<DbSynonymGroup, 'terms' | 'is_active'>[]
}

export interface SearchHit {
  productId: string
  /** The variants that matched; every active variant when the words are in the product itself. */
  variantIds: string[]
  score: number
}

interface Doc {
  id: string
  productId: string
  variantId: string | null
  name: string
  category: string
  variant: string
  sku: string
  description: string
}

const FIELDS = ['name', 'sku', 'variant', 'category', 'description'] as const
const BOOST = { name: 3, sku: 4, variant: 2, category: 1.5, description: 0.5 }
const EXACT_SKU_SCORE = 1_000_000

/** A word of 4+ characters may be one edit off: "ارجيلا" finds "ارجيلة". */
const fuzzy = (term: string) => (term.length >= 4 ? 1 : false)

export class CatalogSearch {
  private readonly index: MiniSearch<Doc>
  /** word → the other words of every group it belongs to. */
  private readonly related = new Map<string, Set<string>>()
  private readonly bySku = new Map<string, { productId: string; variantId: string }[]>()

  constructor(input: SearchInput) {
    for (const group of input.synonyms ?? []) {
      if (!group.is_active) continue
      const terms = [...new Set(group.terms.map(normalizeArabic).filter(Boolean))]
      for (const term of terms) {
        const others = this.related.get(term) ?? new Set<string>()
        for (const other of terms) if (other !== term) others.add(other)
        this.related.set(term, others)
      }
    }

    this.index = new MiniSearch<Doc>({
      fields: [...FIELDS],
      storeFields: ['productId', 'variantId'],
      // The text is normalized before it goes in (a hyphen in a SKU is a space), so words only
      // need to be split on spaces.
      tokenize: (text) => text.split(' ').filter(Boolean),
      processTerm: (term) => term,
      searchOptions: { prefix: true, fuzzy, boost: BOOST, combineWith: 'AND' },
    })

    const categoryNames = new Map(input.categories.map((c) => [c.id, normalizeArabic(c.name)]))
    const variantsOf = new Map<string, SearchInput['variants']>()
    for (const v of input.variants) {
      if (!v.is_active) continue
      variantsOf.set(v.product_id, [...(variantsOf.get(v.product_id) ?? []), v])
    }
    const docs: Doc[] = []
    for (const p of input.products) {
      const base = {
        productId: p.id,
        name: normalizeArabic(p.name),
        category: categoryNames.get(p.category_id) ?? '',
        description: normalizeArabic(p.description ?? ''),
      }
      const variants = variantsOf.get(p.id) ?? []
      // A product with no variant yet is still found by its name.
      if (variants.length === 0) {
        docs.push({ ...base, id: `p:${p.id}`, variantId: null, variant: '', sku: '' })
        continue
      }
      for (const v of variants) {
        const sku = normalizeArabic(v.sku)
        docs.push({
          ...base,
          id: v.id,
          variantId: v.id,
          variant: normalizeArabic(`${v.color ?? ''} ${v.size ?? ''}`),
          sku,
        })
        this.bySku.set(sku, [...(this.bySku.get(sku) ?? []), { productId: p.id, variantId: v.id }])
      }
    }
    this.index.addAll(docs)
  }

  /** The query as the index understands it: every word, each one or any of its synonyms. */
  private toQuery(tokens: string[]): Query {
    return {
      combineWith: 'AND',
      queries: tokens.map((token) => ({
        combineWith: 'OR',
        queries: [token, ...(this.related.get(token) ?? [])].map((term): Query =>
          term.includes(' ') ? { combineWith: 'AND', queries: term.split(' ') } : term,
        ),
      })),
    }
  }

  search(query: string): SearchHit[] {
    const normalized = normalizeArabic(query)
    if (normalized === '') return []
    const hits = new Map<string, { score: number; variantIds: Set<string> }>()
    const add = (productId: string, variantId: string | null, score: number) => {
      const hit = hits.get(productId) ?? { score: 0, variantIds: new Set<string>() }
      hit.score = Math.max(hit.score, score)
      if (variantId) hit.variantIds.add(variantId)
      hits.set(productId, hit)
    }
    for (const found of this.index.search(this.toQuery(normalized.split(' ')))) {
      add(found.productId as string, found.variantId as string | null, found.score)
    }
    for (const exact of this.bySku.get(normalized) ?? []) {
      add(exact.productId, exact.variantId, EXACT_SKU_SCORE)
    }
    return [...hits]
      .map(([productId, hit]) => ({
        productId,
        variantIds: [...hit.variantIds],
        score: hit.score,
      }))
      .sort((a, b) => b.score - a.score || a.productId.localeCompare(b.productId))
  }
}

// The index is rebuilt only when what it is made of changes. The catalog snapshot is read again on
// every change anywhere (a stock level, a picture, a waiting command), and none of those touch the
// words in the index, so the key is the text that goes in, not the snapshot object: rebuilding costs
// 0.2 s on a PC and several times that on an iPad.
const signature = (input: SearchInput): string =>
  [
    input.categories.map((c) => `${c.id}\u0001${c.name}`).join('\u0002'),
    input.products
      .map((p) => `${p.id}\u0001${p.category_id}\u0001${p.name}\u0001${p.description ?? ''}`)
      .join('\u0002'),
    input.variants
      .map(
        (v) =>
          `${v.id}\u0001${v.sku}\u0001${v.color ?? ''}\u0001${v.size ?? ''}\u0001${v.is_active}`,
      )
      .join('\u0002'),
    (input.synonyms ?? [])
      .map((g) => `${g.is_active}\u0001${g.terms.join('\u0003')}`)
      .join('\u0002'),
  ].join('\u0004')

let last: { signature: string; engine: CatalogSearch } | undefined

export function searchFor(input: SearchInput): CatalogSearch {
  const key = signature(input)
  if (last?.signature !== key) last = { signature: key, engine: new CatalogSearch(input) }
  return last.engine
}
