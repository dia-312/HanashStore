import { describe, expect, it } from 'vitest'
import { CatalogSearch } from './search'

// QA: how long the index takes to build, and how long a search takes, at the sizes the SPEC names
// (2,000 variants) and well beyond (the client may grow). The index is rebuilt whenever the catalog
// snapshot changes, so the build time is the cost of every pull that touches products or stock.

const colors = ['أسود', 'أحمر', 'أزرق', 'فضي', 'ذهبي', 'أخضر', 'أبيض', 'بنفسجي']
const names = ['أرجيلة', 'بربيش', 'فحم', 'رأس', 'ماسك', 'حجر', 'خرطوم', 'ملقط']

const make = (variantCount: number) => {
  const perProduct = 5
  const productCount = Math.ceil(variantCount / perProduct)
  const categories = names.map((n, i) => ({ id: `c${i}`, name: `فئة ${n}` }))
  const products = Array.from({ length: productCount }, (_, i) => ({
    id: `p${i}`,
    category_id: `c${i % categories.length}`,
    name: `${names[i % names.length]} موديل ${i} ${colors[i % colors.length]}`,
    description: i % 3 === 0 ? 'وصف طويل نوعاً ما للمنتج يحتوي كلمات كثيرة مختلفة' : null,
  }))
  const variants = products.flatMap((p, i) =>
    Array.from({ length: perProduct }, (_, j) => ({
      id: `v${i}-${j}`,
      product_id: p.id,
      sku: `SKU-${String(i * perProduct + j).padStart(6, '0')}`,
      color: colors[(i + j) % colors.length]!,
      size: j % 2 === 0 ? String(10 + j) : null,
      is_active: true,
    })),
  )
  return {
    categories,
    products,
    variants: variants.slice(0, variantCount),
    synonyms: [{ terms: ['ارجيله', 'شيشه', 'اركيله'], is_active: true }],
  }
}

describe('search at scale', () => {
  it.each([2_000, 5_000, 10_000])('%i variants: build and search time', (n) => {
    const data = make(n)
    const t0 = performance.now()
    const engine = new CatalogSearch(data)
    const build = performance.now() - t0
    const queries = [
      'ارجيله',
      'شيشة اسود',
      'بربيش احمر ١٠',
      'ارج',
      'ارجيلا',
      'SKU-000777',
      'فحم',
      'x',
    ]
    for (const q of queries) engine.search(q) // warm up
    const times = queries.map((q) => {
      const s = performance.now()
      engine.search(q)
      return performance.now() - s
    })
    console.log(
      `QA search ${n} variants: build ${build.toFixed(0)} ms, search worst ${Math.max(...times).toFixed(1)} ms, median ${[...times].sort((a, b) => a - b)[4]!.toFixed(1)} ms`,
    )
    // generous bounds for a slow CI machine; the real numbers are printed above
    expect(build).toBeLessThan(5_000)
    expect(Math.max(...times)).toBeLessThan(500)
  })
})
