import { describe, expect, it } from 'vitest'
import { CatalogSearch, type SearchInput } from './search'

// SPEC section 9, "Required test cases", plus the rules around them.

const SEED_GROUPS = [
  ['ارجيله', 'اركيله', 'شيشه', 'نرجيله'],
  ['بربيش', 'لي', 'خرطوم'],
  ['فحم', 'فحمات'],
  ['راس', 'حجر'],
  ['ماسك', 'مبسم'],
].map((terms) => ({ terms, is_active: true }))

const categories = [
  { id: 'c-hookah', name: 'أراجيل' },
  { id: 'c-hose', name: 'خراطيم' },
  { id: 'c-coal', name: 'فحم' },
  { id: 'c-bowl', name: 'رؤوس' },
]

let n = 0
const variant = (productId: string, sku: string, color: string | null, size: string | null) => ({
  id: `v-${++n}`,
  product_id: productId,
  sku,
  color,
  size,
  is_active: true,
})

const products = [
  { id: 'p-big', category_id: 'c-hookah', name: 'أرجيلة كبيرة', description: null },
  { id: 'p-small', category_id: 'c-hookah', name: 'أرجيلة صغيرة', description: 'للسفر' },
  { id: 'p-hose', category_id: 'c-hose', name: 'بربيش سيليكون', description: null },
  { id: 'p-coal', category_id: 'c-coal', name: 'فحم كوكو', description: null },
  { id: 'p-bowl', category_id: 'c-bowl', name: 'رأس سيراميك', description: null },
  { id: 'p-bare', category_id: 'c-hookah', name: 'أرجيلة جديدة', description: null },
]

const variants = [
  variant('p-big', 'SKU-000001', 'أسود', null),
  variant('p-big', 'SKU-000002', 'فضي', null),
  variant('p-small', 'SKU-000003', 'أحمر', null),
  variant('p-hose', 'SKU-000004', 'أسود', null),
  variant('p-hose', 'SKU-000005', 'أحمر', null),
  variant('p-coal', 'SKU-000006', null, '25'),
  variant('p-coal', 'SKU-000007', null, '10'),
  variant('p-bowl', 'SKU-000008', 'أبيض', null),
]
const byColor = (productId: string, color: string) =>
  variants.find((v) => v.product_id === productId && v.color === color)!.id

const input: SearchInput = { categories, products, variants, synonyms: SEED_GROUPS }
const engine = new CatalogSearch(input)
const ids = (query: string, search = engine) => search.search(query).map((h) => h.productId)

describe('required cases', () => {
  it('ارجيله finds the hookahs', () => {
    expect(ids('ارجيله').sort()).toEqual(['p-bare', 'p-big', 'p-small'])
  })

  it('the spelling with a taa marbuta and hamza finds the same', () => {
    expect(ids('أرجيلة').sort()).toEqual(['p-bare', 'p-big', 'p-small'])
  })

  it('اركيلة finds them through the synonym group', () => {
    expect(ids('اركيلة').sort()).toEqual(['p-bare', 'p-big', 'p-small'])
  })

  it('شيشة finds them through the synonym group', () => {
    expect(ids('شيشة').sort()).toEqual(['p-bare', 'p-big', 'p-small'])
  })

  it('بربيش اسود finds the black hose only', () => {
    const hits = engine.search('بربيش اسود')
    expect(hits.map((h) => h.productId)).toEqual(['p-hose'])
    expect(hits[0]?.variantIds).toEqual([byColor('p-hose', 'أسود')])
  })

  it('ارج (a prefix) finds all hookahs and nothing else', () => {
    expect(ids('ارج').sort()).toEqual(['p-bare', 'p-big', 'p-small'])
  })

  it('ارجيلا (one letter off) finds the hookahs', () => {
    expect(ids('ارجيلا').sort()).toEqual(['p-bare', 'p-big', 'p-small'])
  })

  it('فحم ٢٥ (an Arabic digit) finds the size 25 charcoal only', () => {
    const hits = engine.search('فحم ٢٥')
    expect(hits.map((h) => h.productId)).toEqual(['p-coal'])
    expect(hits[0]?.variantIds).toEqual([variants.find((v) => v.size === '25')!.id])
  })

  it('a SKU in any case finds that variant first', () => {
    for (const typed of ['sku-000004', 'SKU-000004', 'Sku-000004', 'sku 000004']) {
      const hits = engine.search(typed)
      expect(hits[0]?.productId, typed).toBe('p-hose')
      expect(hits[0]?.variantIds, typed).toContain(variants[3]!.id)
    }
  })

  it('an exact SKU outranks a product whose name has the same words', () => {
    const tricky = new CatalogSearch({
      ...input,
      products: [
        ...products,
        { id: 'p-named', category_id: 'c-coal', name: 'sku 000006 حزمة', description: null },
      ],
    })
    expect(tricky.search('SKU-000006')[0]?.productId).toBe('p-coal')
  })
})

describe('the rules around them', () => {
  it('finds the words in any order', () => {
    expect(ids('اسود بربيش')).toEqual(['p-hose'])
  })

  it('every word must be found', () => {
    expect(ids('بربيش اخضر')).toEqual([])
    expect(ids('ارجيله فحم')).toEqual([])
  })

  it('the synonym of a word that is not in a group is not invented', () => {
    expect(ids('قهوه')).toEqual([])
  })

  it('a synonym works in both directions and for a short word', () => {
    // لي (two letters, no typo tolerance) stands for بربيش and خرطوم.
    expect(ids('لي')).toContain('p-hose')
    expect(ids('خرطوم')).toEqual(['p-hose'])
  })

  it('the synonym word is not needed in the product', () => {
    // The head is called رأس; حجر is only in the group.
    expect(ids('حجر')).toEqual(['p-bowl'])
  })

  it('a synonym that has been switched off does nothing', () => {
    const off = new CatalogSearch({
      ...input,
      synonyms: SEED_GROUPS.map((g) => ({ ...g, is_active: false })),
    })
    expect(ids('شيشة', off)).toEqual([])
  })

  it('a short word is not corrected, a long one is', () => {
    expect(ids('رام')).toEqual([])
    expect(ids('سيراميك')).toEqual(['p-bowl'])
    expect(ids('سيراميل')).toEqual(['p-bowl'])
  })

  it('finds the category and the description', () => {
    expect(ids('خراطيم')).toEqual(['p-hose'])
    expect(ids('للسفر')).toEqual(['p-small'])
  })

  it('finds a product that has no variant yet by its name', () => {
    expect(ids('جديدة')).toEqual(['p-bare'])
  })

  it('ignores a stopped variant', () => {
    const stopped = new CatalogSearch({
      ...input,
      variants: variants.map((v) => (v.sku === 'SKU-000004' ? { ...v, is_active: false } : v)),
    })
    expect(stopped.search('بربيش اسود')).toEqual([])
    expect(ids('بربيش احمر', stopped)).toEqual(['p-hose'])
  })

  it('an empty or punctuation-only query finds nothing', () => {
    expect(engine.search('')).toEqual([])
    expect(engine.search('  --  ')).toEqual([])
  })
})

describe('speed', () => {
  it('searches 2,000 variants in under 50 ms', () => {
    const colors = ['أسود', 'أحمر', 'أزرق', 'فضي', 'ذهبي', 'أخضر', 'أبيض', 'بنفسجي']
    const manyProducts = Array.from({ length: 400 }, (_, i) => ({
      id: `bp-${i}`,
      category_id: categories[i % categories.length]!.id,
      name: `منتج ${i} ${['أرجيلة', 'بربيش', 'فحم', 'رأس'][i % 4]}`,
      description: i % 3 === 0 ? 'وصف طويل نوعاً ما للمنتج' : null,
    }))
    const manyVariants = manyProducts.flatMap((p, i) =>
      Array.from({ length: 5 }, (_, j) => ({
        id: `bv-${i}-${j}`,
        product_id: p.id,
        sku: `SKU-${String(i * 5 + j).padStart(6, '0')}`,
        color: colors[(i + j) % colors.length]!,
        size: j % 2 === 0 ? String(10 + j) : null,
        is_active: true,
      })),
    )
    expect(manyVariants).toHaveLength(2000)
    const big = new CatalogSearch({
      categories,
      products: manyProducts,
      variants: manyVariants,
      synonyms: SEED_GROUPS,
    })
    const queries = ['ارجيله', 'اركيلة اسود', 'بربيش احمر', 'فحم ١٠', 'ارج', 'ارجيلا', 'SKU-000777']
    for (const q of queries) big.search(q) // warm up
    const times = queries.map((q) => {
      const start = performance.now()
      big.search(q)
      return performance.now() - start
    })
    expect(Math.max(...times)).toBeLessThan(50)
  })
})
