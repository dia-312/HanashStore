import { describe, expect, it } from 'vitest'
import { normalizeArabic } from './normalize'
import { CatalogSearch, type SearchInput } from './search'

// QA: the search engine against a plain reference written separately, on random catalogs and random
// queries. Recall: whatever a person types from the words he can see (in any spelling of the
// letters) finds that item. Precision: nothing comes back that the plain rules would not give.

const mulberry32 = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const WORDS = [
  'أرجيلة',
  'شيشة',
  'بربيش',
  'خرطوم',
  'فحم',
  'فحمات',
  'رأس',
  'حجر',
  'ماسك',
  'مبسم',
  'سيراميك',
  'زجاج',
  'فوهة',
  'ملقط',
  'ستانلس',
  'كبيرة',
  'صغيرة',
  'متوسطة',
  'فاخرة',
  'اقتصادية',
  'مستورد',
  'محلي',
  'تفاحتين',
  'نعناع',
  'مشروب',
  'قطعة',
  'علبة',
  'كرتونة',
  'مؤسسة',
  'إيطالي',
  'تركي',
  'ألماني',
]
const COLORS = ['أسود', 'أحمر', 'أزرق', 'فضي', 'ذهبي', 'أخضر', 'أبيض', 'بنفسجي', 'شفاف']
const SYNONYMS = [
  ['ارجيله', 'اركيله', 'شيشه', 'نرجيله'],
  ['بربيش', 'لي', 'خرطوم'],
  ['فحم', 'فحمات'],
  ['راس', 'حجر'],
  ['ماسك', 'مبسم'],
]

const editDistance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = keep
    }
  }
  return row[b.length]!
}

/** The same letters spelled differently, the way people type: ة/ه, ى/ي, hamza forms, Arabic digits. */
const respell = (text: string, rnd: () => number): string =>
  [...text]
    .map((c) => {
      if (rnd() < 0.5) return c
      return (
        (
          {
            ة: 'ه',
            ه: 'ة',
            ي: 'ى',
            ى: 'ي',
            ا: 'أ',
            أ: 'ا',
            إ: 'ا',
            '1': '١',
            '2': '٢',
            '5': '٥',
          } as Record<string, string>
        )[c] ?? c
      )
    })
    .join('')

interface Doc {
  variantId: string
  productId: string
  words: string[]
}

const build = (rnd: () => number, products: number) => {
  const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)]!
  const data: SearchInput = {
    categories: [{ id: 'c', name: 'فئة عامة' }],
    products: [],
    variants: [],
    synonyms: SYNONYMS.map((terms) => ({ terms, is_active: true })),
  }
  const docs: Doc[] = []
  for (let i = 0; i < products; i++) {
    const name = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(WORDS)).join(' ')
    const description = rnd() < 0.4 ? pick(WORDS) : null
    data.products.push({ id: `p${i}`, category_id: 'c', name, description })
    for (let j = 0; j < 1 + Math.floor(rnd() * 4); j++) {
      const v = {
        id: `v${i}-${j}`,
        product_id: `p${i}`,
        sku: `SKU-${String(i * 10 + j).padStart(5, '0')}`,
        color: rnd() < 0.8 ? pick(COLORS) : null,
        size: rnd() < 0.5 ? String(10 + Math.floor(rnd() * 40)) : null,
        is_active: true,
      }
      data.variants.push(v)
      docs.push({
        variantId: v.id,
        productId: `p${i}`,
        words: normalizeArabic(
          [name, 'فئة عامة', description ?? '', v.color ?? '', v.size ?? '', v.sku].join(' '),
        ).split(' '),
      })
    }
  }
  return { data, docs }
}

const related = new Map<string, string[]>()
for (const g of SYNONYMS) {
  const terms = g.map(normalizeArabic)
  for (const t of terms) related.set(t, terms)
}

/** The rules of SPEC section 9 written plainly. */
const reference = (docs: Doc[], query: string): Set<string> => {
  const tokens = normalizeArabic(query).split(' ').filter(Boolean)
  const hits = new Set<string>()
  const wordMatches = (token: string, word: string) =>
    word.startsWith(token) || (token.length >= 4 && editDistance(token, word) <= 1)
  for (const doc of docs) {
    const ok = tokens.every((token) =>
      (related.get(token) ?? [token]).some((alt) =>
        alt.split(' ').every((part) => doc.words.some((w) => wordMatches(part, w))),
      ),
    )
    if (ok) hits.add(doc.variantId)
  }
  return hits
}

describe('search against a plain reference', () => {
  it.each([1, 2, 3, 4, 5, 6])('seed %i: nothing missed, nothing extra', (seed) => {
    const rnd = mulberry32(seed)
    const { data, docs } = build(rnd, 120)
    const engine = new CatalogSearch(data)
    const misses: string[] = []
    const extras: string[] = []
    for (let n = 0; n < 250; n++) {
      const doc = docs[Math.floor(rnd() * docs.length)]!
      // 1-3 words of this item, each cut to a prefix of 1-all letters, respelled at random
      const tokens = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
        const w = doc.words[Math.floor(rnd() * doc.words.length)]!
        const cut = w.slice(0, 1 + Math.floor(rnd() * w.length))
        return respell(cut, rnd)
      })
      const query = tokens.join(' ')
      const got = new Set(engine.search(query).flatMap((h) => h.variantIds))
      const want = reference(docs, query)
      // recall: the item the words came from is always found (unless a word was reduced to nothing)
      if (normalizeArabic(query) && !got.has(doc.variantId))
        misses.push(`${query} -> ${doc.variantId}`)
      // precision and recall against the reference, variant by variant
      for (const id of want) if (!got.has(id)) misses.push(`ref has ${id} for "${query}"`)
      for (const id of got) if (!want.has(id)) extras.push(`engine has ${id} for "${query}"`)
    }
    expect(misses.slice(0, 8)).toEqual([])
    expect(extras.slice(0, 8)).toEqual([])
  })
})
