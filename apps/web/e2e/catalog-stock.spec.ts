import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test'
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
let pw: PlaywrightWorkerArgs['playwright']
let origin = ''
let serverApi: APIRequestContext | undefined

// Talks to the server directly, with the browser's session, so it keeps working while the browser
// itself is switched offline.
const server = async () => {
  serverApi ??= await pw.request.newContext({
    baseURL: origin,
    storageState: await page.context().storageState(),
    extraHTTPHeaders: { 'X-Requested-With': 'app' },
  })
  return serverApi
}

const json = async <T>(url: string): Promise<T> => {
  const res = await (await server()).get(url)
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

test.beforeAll(async ({ browser, playwright, baseURL }) => {
  pw = playwright
  origin = baseURL ?? ''
  page = await (await browser.newContext()).newPage()
})
test.afterAll(async () => {
  await serverApi?.dispose()
  await page.context().close()
})

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

test('first sync puts the whole catalog on the device (seeded stack only)', async () => {
  test.skip(!process.env.E2E_SEED, 'needs the large seed: see scripts/e2e.sh')
  // Browser storage in headless WebKit on a PC is far slower than on an iPad (about 15 ms per row
  // written), so this one is given plenty of time. The point is that it ends up complete.
  test.setTimeout(400_000)
  const started = Date.now()
  await goTo(ar.nav.catalog)
  await expect(page.locator('a[href^="/catalog/"]').first()).toBeVisible({ timeout: 120_000 })
  console.log('first sync to first row (ms):', Date.now() - started)

  const counts = () =>
    page.evaluate(
      () =>
        new Promise<Record<string, number>>((resolve) => {
          const open = indexedDB.open('sales-rep')
          open.onsuccess = () => {
            const tables = ['products', 'variants', 'images']
            const tx = open.result.transaction(tables)
            const out: Record<string, number> = {}
            for (const name of tables) {
              const request = tx.objectStore(name).count()
              request.onsuccess = () => {
                out[name] = request.result
                if (Object.keys(out).length === tables.length) resolve(out)
              }
            }
          }
        }),
    )
  await expect
    .poll(async () => (await counts()).variants, { timeout: 300_000 })
    .toBeGreaterThanOrEqual(2000)
  expect((await counts()).products).toBeGreaterThanOrEqual(400)

  // Opening the catalog again reads only the device.
  await goTo(ar.nav.stock)
  const reopened = Date.now()
  await goTo(ar.nav.catalog)
  await expect(page.locator('a[href^="/catalog/"]').first()).toBeVisible()
  console.log('catalog reopened from the device (ms):', Date.now() - reopened)
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
  console.log('catalog open (ms):', Date.now() - started)
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

const FOHA = 'فوهة زجاج' // imported with 120 in stock

const device = async () => (await json<{ device: { id: string } }>('/api/v1/auth/me')).device.id

const pushToServer = async (commands: unknown[]) => {
  const res = await (
    await server()
  ).post('/api/v1/sync/push', {
    data: { device_id: await device(), commands },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return (await res.json()) as { results: { status: string; error?: { code: string } }[] }
}

const command = (type: string, payload: unknown) => ({
  id: crypto.randomUUID(),
  type,
  schema_version: 1,
  created_at: new Date().toISOString(),
  payload,
})

const fohaStock = async () => (await findProduct(FOHA)).variants[0]?.stock_qty
const chip = (text: RegExp) => page.getByRole('link', { name: text })

test('a damage larger than the stock is refused by the server and changes nothing', async () => {
  const product = await findProduct('جمر سريع الاشتعال')
  const variant = product.variants[0]
  const before = variant?.stock_qty
  const { results } = await pushToServer([
    command('stock.damage', {
      movement_id: crypto.randomUUID(),
      variant_id: variant?.id,
      qty: 100_000,
      note: 'x',
    }),
  ])
  expect(results[0]).toMatchObject({ status: 'rejected', error: { code: 'INSUFFICIENT_STOCK' } })
  expect((await findProduct('جمر سريع الاشتعال')).variants[0]?.stock_qty).toBe(before)
})

test('the same command sent twice applies once', async () => {
  const variant = (await findProduct(FOHA)).variants[0]
  const before = (await fohaStock()) ?? 0
  const once = command('stock.purchase', {
    note: null,
    items: [{ movement_id: crypto.randomUUID(), variant_id: variant?.id, qty: 3 }],
  })
  const first = await pushToServer([once])
  const second = await pushToServer([once])
  expect(first.results[0]?.status).toBe('applied')
  expect(second.results).toEqual(first.results)
  expect(await fohaStock()).toBe(before + 3)
})

test('offline: the catalog is there, a stock-in is saved on the device and shown at once', async () => {
  const before = (await fohaStock()) ?? 0
  // Opening the catalog asks the server what changed: the +3 the previous test made on the server
  // (not through this device) is there without waiting for the next minute.
  await goTo(ar.nav.catalog)
  await expect(page.getByText(new RegExp(`متوفر.*${before}`)).first()).toBeVisible()
  await page.context().setOffline(true)
  await expect(chip(/بدون اتصال/)).toBeVisible()

  await goTo(ar.nav.catalog)
  await expect(page.getByText(FOHA).first()).toBeVisible()

  await goTo(ar.nav.stock)
  await page.getByRole('searchbox', { name: ar.stock.search }).fill('فوهة')
  await page
    .getByRole('button', { name: /فوهة زجاج/ })
    .first()
    .click()
  await page.getByLabel(new RegExp(`^${ar.stock.qty}`)).fill('7')
  await page.getByRole('button', { name: ar.stock.submitIn }).click()
  await page.getByRole('dialog').getByRole('button', { name: ar.form.confirm }).click()
  await expect(page.getByText(ar.stock.queued)).toBeVisible()
  await expect(chip(/بانتظار الإرسال/)).toBeVisible()

  // The catalog already shows the new quantity; the server has not heard about it yet.
  await goTo(ar.nav.catalog)
  await expect(page.getByText(new RegExp(`متوفر.*${before + 7}`)).first()).toBeVisible()
  expect(await fohaStock()).toBe(before)

  // The network comes back: it is sent without anyone pressing anything.
  await page.context().setOffline(false)
  await expect.poll(fohaStock, { timeout: 60_000 }).toBe(before + 7)
  await expect(chip(/تمت المزامنة/)).toBeVisible({ timeout: 60_000 })
})

test('offline: a write-off larger than the stock cannot even be confirmed', async () => {
  await page.context().setOffline(true)
  await goTo(ar.nav.stock)
  await page.getByRole('tab', { name: ar.stock.tabDamage }).click()
  await page.getByRole('searchbox', { name: ar.stock.search }).fill('فوهة')
  await page
    .getByRole('button', { name: /فوهة زجاج/ })
    .first()
    .click()
  await page.getByLabel(ar.stock.damageQty).fill('100000')
  await page.getByLabel(ar.stock.damageReason).fill('x')
  await expect(page.getByRole('button', { name: ar.stock.submitDamage })).toBeDisabled()
  await page.context().setOffline(false)
})

test('a command the server refuses shows on the sync screen and can be discarded', async () => {
  const variant = (await findProduct(FOHA)).variants[0]
  await page.context().setOffline(true)

  // Offline the rep writes off 50, which the device allows (it shows well over 50).
  await goTo(ar.nav.stock)
  await page.getByRole('tab', { name: ar.stock.tabDamage }).click()
  await page.getByRole('searchbox', { name: ar.stock.search }).fill('فوهة')
  await page
    .getByRole('button', { name: /فوهة زجاج/ })
    .first()
    .click()
  await page.getByLabel(ar.stock.damageQty).fill('50')
  await page.getByLabel(ar.stock.damageReason).fill('كسر')
  await page.getByRole('button', { name: ar.stock.submitDamage }).click()
  await page.getByRole('dialog').getByRole('button', { name: ar.form.confirm }).click()
  await expect(page.getByText(ar.stock.queued)).toBeVisible()

  // Meanwhile the server's stock drops to 10 (a count from elsewhere): the write-off no longer fits.
  await pushToServer([
    command('stock.adjust', {
      movement_id: crypto.randomUUID(),
      variant_id: variant?.id,
      counted_qty: 10,
      expected_qty: 130,
      note: 'count',
    }),
  ])
  await page.context().setOffline(false)

  await expect(chip(/مشكلة في المزامنة/)).toBeVisible({ timeout: 60_000 })
  await chip(/مشكلة في المزامنة/).click()
  await expect(page.getByText(/الكمية المتوفرة على الخادم أقل من المطلوب \(10\)/)).toBeVisible()
  expect(await fohaStock()).toBe(10)

  await page.getByRole('button', { name: ar.sync.discard, exact: true }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: ar.sync.discard }).click()
  await expect(page.getByText(ar.sync.nothingWrong)).toBeVisible()
  await expect(chip(/تمت المزامنة|مشكلة/)).toBeVisible()
})

test('closed and reopened offline, the app unlocks with the PIN and still has the catalog', async () => {
  await page.context().setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: ar.lock.title })).toBeVisible({ timeout: 30_000 })
  await pressPin(PIN)
  await expect(page.getByRole('link', { name: ar.nav.catalog, exact: true }).first()).toBeVisible()
  await goTo(ar.nav.catalog)
  await expect(page.getByText('شيشة نخلة صغيرة').first()).toBeVisible()
  await page.context().setOffline(false)
})
