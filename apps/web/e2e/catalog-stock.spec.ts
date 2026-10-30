import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { ar } from '../src/i18n/ar'

// One journey through M2 in WebKit: login, PIN, import (bad file refused, good file accepted), catalog,
// price edit, photo, stock in / count / damage, history. State is shared, so the steps run in order.
// Needs the stack from docker-compose.e2e.yml with its user created (see the header of that file).
const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-password-123'
const PIN = '1234'
const samples = path.resolve(import.meta.dirname, '../../../samples')

// 1x1 PNG, enough for the upload path (re-encoded to WebP on the server).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

interface Variant {
  id: string
  color: string | null
  price: number
  stock_qty: number
}
interface Product {
  id: string
  name: string
  variants: Variant[]
  images: unknown[]
}

test.describe.configure({ mode: 'serial' })

let page: Page

const json = async <T>(url: string): Promise<T> => {
  const res = await page.request.get(url)
  expect(res.ok(), `${url} -> ${res.status()}`).toBe(true)
  return (await res.json()) as T
}

const findProduct = async (name: string): Promise<Product> => {
  const list = await json<{ items: { id: string; name: string }[] }>(
    `/api/v1/products?q=${encodeURIComponent(name)}`,
  )
  const hit = list.items.find((p) => p.name === name)
  expect(hit, `product ${name}`).toBeTruthy()
  return json<Product>(`/api/v1/products/${hit?.id}`)
}

const goTo = async (label: string) =>
  page.getByRole('link', { name: label, exact: true }).first().click()

const pressPin = async (pin: string) => {
  for (const digit of pin) {
    await page.getByRole('button', { name: digit, exact: true }).click()
    await page.waitForTimeout(60)
  }
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage()
})
test.afterAll(async () => page.context().close())

test('login and PIN', async () => {
  await page.goto('/')
  await page.getByLabel(ar.login.passwordLabel).fill(PASSWORD)
  await page.getByRole('button', { name: ar.login.submit }).click()
  await expect(page.getByRole('heading', { name: ar.setPin.title })).toBeVisible({
    timeout: 20_000,
  })
  await pressPin(PIN)
  await page.getByRole('button', { name: ar.pad.confirm }).click()
  await expect(page.getByRole('heading', { name: ar.setPin.confirmTitle })).toBeVisible()
  await pressPin(PIN)
  await page.getByRole('button', { name: ar.pad.confirm }).click()
  await expect(page.getByRole('link', { name: ar.nav.catalog, exact: true }).first()).toBeVisible()
})

test('a file with a bad row is refused and saves nothing', async () => {
  await goTo(ar.nav.settings)
  await page.getByRole('link', { name: ar.settings.importProducts }).click()
  await page.locator('input[type=file]').setInputFiles(path.join(samples, 'import-with-error.xlsx'))
  await expect(page.getByText(ar.importer.errorsHint)).toBeVisible()
  await expect(page.getByRole('button', { name: ar.importer.start })).toBeDisabled()
  const list = await json<{ items: unknown[] }>(
    '/api/v1/products?q=' + encodeURIComponent('شيشة نخلة'),
  )
  expect(list.items).toHaveLength(0)
})

test('the good file imports with the exact stock of the file', async () => {
  await page.locator('input[type=file]').setInputFiles(path.join(samples, 'import-good.xlsx'))
  await expect(page.getByText(ar.importer.summary)).toBeVisible()
  await page.getByRole('button', { name: ar.importer.start }).click()
  await expect(page.getByText(ar.importer.doneTitle)).toBeVisible()

  const palm = await findProduct('شيشة نخلة صغيرة')
  expect(palm.variants.map((v) => v.stock_qty).sort((a, b) => a - b)).toEqual([4, 6, 10])
  const prices = palm.variants.map((v) => v.price).sort((a, b) => a - b)
  expect(prices).toEqual([14000, 14000, 15550])
  const coal = await findProduct('جمر سريع الاشتعال')
  expect(coal.variants.map((v) => v.stock_qty).sort((a, b) => a - b)).toEqual([50, 80])
})

test('catalog shows the products and search finds them', async () => {
  const started = Date.now()
  await goTo(ar.nav.catalog)
  await expect(page.getByText('شيشة نخلة صغيرة').first()).toBeVisible()
  test
    .info()
    .annotations.push({ type: 'catalog-open-ms', description: String(Date.now() - started) })
  await page.getByRole('searchbox', { name: ar.catalog.search }).fill('نخله')
  await expect(page.getByText('شيشة نخلة صغيرة').first()).toBeVisible()
  await expect(page.getByText('جمر سريع الاشتعال')).toHaveCount(0)
})

test('edit a price, add a photo', async () => {
  await page
    .getByRole('link', { name: /شيشة نخلة صغيرة/ })
    .first()
    .click()
  const before = await findProduct('شيشة نخلة صغيرة')

  const row = page.getByLabel(ar.product.price).first()
  await row.fill('150.50')
  // The page has two save buttons (product info, then one per variant): take the one in the price field's card.
  await row
    .locator(`xpath=ancestor::*[.//button[normalize-space()="${ar.form.save}"]][1]`)
    .getByRole('button', { name: ar.form.save, exact: true })
    .click()
  await expect
    .poll(async () => (await findProduct('شيشة نخلة صغيرة')).variants.map((v) => v.price))
    .toContain(15050)

  await page.locator('input[type=file][accept^="image"]').setInputFiles({
    name: 'photo.png',
    mimeType: 'image/png',
    buffer: PNG,
  })
  await expect
    .poll(async () => (await findProduct('شيشة نخلة صغيرة')).images.length)
    .toBe(before.images.length + 1)
})

test('stock in, count and damage change the numbers and the history', async () => {
  const start = await findProduct('جمر سريع الاشتعال')
  const variant = start.variants.find((v) => v.stock_qty === 80)
  expect(variant).toBeTruthy()
  const id = variant?.id ?? ''
  const stock = async () =>
    (await findProduct('جمر سريع الاشتعال')).variants.find((v) => v.id === id)?.stock_qty

  const pick = async () => {
    await page.getByRole('searchbox', { name: ar.stock.search }).fill('جمر')
    await page
      .getByRole('button', { name: /حبة 33/ })
      .first()
      .click()
  }

  // stock in +10
  await goTo(ar.nav.stock)
  await pick()
  await page.getByLabel(new RegExp(`^${ar.stock.qty}`)).fill('10')
  await page.getByRole('button', { name: ar.stock.submitIn }).click()
  await page.getByRole('dialog').getByRole('button', { name: ar.form.confirm }).click()
  await expect.poll(stock).toBe(90)

  // count to 85 (difference -5)
  await goTo(ar.nav.stock)
  await page.getByRole('tab', { name: ar.stock.tabCount }).click()
  await pick()
  await page.getByLabel(ar.stock.counted).fill('85')
  await page.getByLabel(ar.stock.countReason).fill('جرد الرف')
  await page.getByRole('button', { name: ar.stock.submitCount }).click()
  await page.getByRole('dialog').getByRole('button', { name: ar.form.confirm }).click()
  await expect.poll(stock).toBe(85)

  // damage 5
  await goTo(ar.nav.stock)
  await page.getByRole('tab', { name: ar.stock.tabDamage }).click()
  await pick()
  await page.getByLabel(ar.stock.damageQty).fill('5')
  await page.getByLabel(ar.stock.damageReason).fill('كسر')
  await page.getByRole('button', { name: ar.stock.submitDamage }).click()
  await page.getByRole('dialog').getByRole('button', { name: ar.form.confirm }).click()
  await expect.poll(stock).toBe(80)

  // history lists all four movements with the running total
  const moves = await json<{ items: { type: string; qty: number; running_total: number }[] }>(
    `/api/v1/variants/${id}/movements`,
  )
  expect(moves.items.map((m) => m.type).sort()).toEqual([
    'adjustment',
    'damage',
    'opening',
    'purchase',
  ])
  expect(moves.items.map((m) => m.running_total)).toContain(80)
})

test('a negative stock is refused', async () => {
  const product = await findProduct('جمر سريع الاشتعال')
  const variant = product.variants[0]
  const res = await page.request.post('/api/v1/stock/damage', {
    headers: { 'X-Requested-With': 'app' },
    data: { id: crypto.randomUUID(), variant_id: variant?.id, qty: 100000, note: 'x' },
  })
  expect(res.status()).toBe(409)
})
