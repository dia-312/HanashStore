import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import path from 'node:path'
import { ar } from '../src/i18n/ar'

// QA walk: every screen of the app, in both iPad orientations, measured in a real WebKit. It reports
// what a person would trip on (targets under 44 px, controls with no name, pictures with no text,
// sideways scrolling, errors in the console) instead of what the code says it does.
const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-password-123'
const PIN = '1234'
const samples = path.resolve(import.meta.dirname, '../../../samples')

// Only on request: `bash scripts/e2e.sh qa` (it starts on a fresh database of its own).
test.skip(!process.env.E2E_QA, 'QA walk runs only with E2E_QA=1')
test.describe.configure({ mode: 'serial' })

let page: Page
let api: APIRequestContext
const problems: string[] = []
const consoleErrors: string[] = []

const pressPin = async (pin: string) => {
  for (const digit of pin) {
    await page.getByRole('button', { name: digit, exact: true }).click()
    await page.waitForTimeout(60)
  }
}

/** Client-side navigation: a reload would lock the app and ask for the PIN again. */
const go = async (route: string) => {
  await page.evaluate((to) => {
    history.pushState({}, '', to)
    dispatchEvent(new PopStateEvent('popstate'))
  }, route)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(700)
}

interface Finding {
  kind: string
  detail: string
}

const audit = async (label: string): Promise<Finding[]> =>
  page
    .evaluate(() => {
      const out: { kind: string; detail: string }[] = []
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
      }
      const nameOf = (el: Element): string => {
        const aria = el.getAttribute('aria-label')
        if (aria?.trim()) return aria.trim()
        const by = el.getAttribute('aria-labelledby')
        if (by) {
          const t = by
            .split(' ')
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
            .trim()
          if (t) return t
        }
        const id = el.getAttribute('id')
        if (id) {
          const l = document.querySelector(`label[for="${CSS.escape(id)}"]`)
          if (l?.textContent?.trim()) return l.textContent.trim()
        }
        const wrap = el.closest('label')
        if (wrap?.textContent?.trim()) return wrap.textContent.trim()
        if (el.getAttribute('title')?.trim()) return el.getAttribute('title')!.trim()
        return (el.textContent ?? '').trim()
      }
      const describe = (el: Element) =>
        `<${el.tagName.toLowerCase()}> "${nameOf(el).slice(0, 40)}" ${el.className.toString().slice(0, 50)}`

      const targets = document.querySelectorAll(
        'a[href], button, input:not([type=hidden]):not([type=file]), select, textarea, [role=button], [role=tab], summary',
      )
      for (const el of targets) {
        if (!visible(el) || el.closest('.sr-only')) continue
        const r = el.getBoundingClientRect()
        if (Math.min(r.width, r.height) < 43.5)
          out.push({
            kind: 'small-target',
            detail: `${Math.round(r.width)}x${Math.round(r.height)} ${describe(el)}`,
          })
        const placeholder = el.getAttribute('placeholder') ?? ''
        if (!nameOf(el) && !placeholder) out.push({ kind: 'no-name', detail: describe(el) })
        if (r.right > window.innerWidth + 1 || r.left < -1)
          out.push({ kind: 'off-screen', detail: describe(el) })
      }
      for (const img of document.querySelectorAll('img')) {
        if (!visible(img)) continue
        if (!img.hasAttribute('alt')) out.push({ kind: 'img-no-alt', detail: img.src.slice(-40) })
      }
      if (document.documentElement.scrollWidth > window.innerWidth + 1)
        out.push({
          kind: 'sideways-scroll',
          detail: `${document.documentElement.scrollWidth} > ${window.innerWidth}`,
        })
      if (document.documentElement.lang !== 'ar' || document.documentElement.dir !== 'rtl')
        out.push({
          kind: 'lang-dir',
          detail: `${document.documentElement.lang}/${document.documentElement.dir}`,
        })
      if (!document.title.trim()) out.push({ kind: 'no-title', detail: '' })
      // a status shown by colour alone: a badge with a colour class and no text
      for (const el of document.querySelectorAll(
        '[class*="bg-red"], [class*="bg-green"], [class*="bg-amber"]',
      )) {
        if (visible(el) && !(el.textContent ?? '').trim())
          out.push({ kind: 'colour-only', detail: describe(el) })
      }
      return out
    })
    .then((found) => found.map((f) => ({ ...f, detail: `[${label}] ${f.detail}` })))

test.beforeAll(async ({ browser, playwright, baseURL }) => {
  page = await (await browser.newContext()).newPage()
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`console: ${m.text()}`))
  api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { 'X-Requested-With': 'app' },
  })
})
test.afterAll(async () => {
  console.log('QA-AUDIT problems:\n' + problems.join('\n'))
  console.log('QA-AUDIT console errors:\n' + consoleErrors.join('\n'))
  await api.dispose()
  await page.context().close()
})

test('sign in, set the PIN, import the products, make a customer and a sale', async () => {
  await page.goto('/')
  await page.getByLabel(ar.login.passwordLabel).fill(PASSWORD)
  await page.getByRole('button', { name: ar.login.submit }).click()
  await expect(page.getByRole('heading', { name: ar.setPin.title })).toBeVisible({
    timeout: 30_000,
  })
  await pressPin(PIN)
  await page.getByRole('button', { name: ar.pad.confirm }).click()
  await pressPin(PIN)
  await page.getByRole('button', { name: ar.pad.confirm }).click()
  await expect(page.getByRole('link', { name: ar.nav.catalog, exact: true }).first()).toBeVisible()

  await go('/settings/import')
  await page.locator('input[type=file]').setInputFiles(path.join(samples, 'import-good.xlsx'))
  await page.getByRole('button', { name: ar.importer.start }).click()
  await expect(page.getByText(ar.importer.doneTitle)).toBeVisible()

  // the same session, for talking to the server directly
  const state = await page.context().storageState()
  api = await (
    await import('@playwright/test')
  ).request.newContext({
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8090',
    storageState: state,
    extraHTTPHeaders: { 'X-Requested-With': 'app' },
  })
  const me = (await (await api.get('/api/v1/auth/me')).json()) as { device: { id: string } }
  const list = (await (await api.get('/api/v1/products?limit=50')).json()) as {
    items: { id: string; name: string }[]
  }
  const coal = list.items.find((p) => p.name.includes('جمر'))!
  const detail = (await (await api.get(`/api/v1/products/${coal.id}`)).json()) as {
    variants: { id: string; price: number }[]
  }
  const customerId = crypto.randomUUID()
  const invoiceId = crypto.randomUUID()
  const lineId = crypto.randomUUID()
  const cmd = (type: string, payload: unknown) => ({
    id: crypto.randomUUID(),
    type,
    schema_version: 1,
    created_at: new Date().toISOString(),
    payload,
  })
  const pushed = await api.post('/api/v1/sync/push', {
    data: {
      device_id: me.device.id,
      commands: [
        cmd('customer.upsert', { customer_id: customerId, name: 'محل الفحص', phone: '0599000000' }),
        cmd('invoice.create', {
          invoice_id: invoiceId,
          number: 'INV-000001',
          customer_id: customerId,
          issued_at: new Date().toISOString(),
          discount: 100,
          note: null,
          lines: [
            {
              line_id: lineId,
              variant_id: detail.variants[0]!.id,
              qty: 4,
              unit_price: detail.variants[0]!.price,
            },
          ],
          payment: {
            payment_id: crypto.randomUUID(),
            number: 'REC-000001',
            amount: 1000,
            method: 'cash',
            note: null,
          },
        }),
      ],
    },
  })
  expect(pushed.ok()).toBe(true)
  const route = {
    customerId,
    invoiceId,
    productId: coal.id,
  }
  ;(globalThis as Record<string, unknown>).qaRoutes = route
  // let the device pull what the server now has
  await go('/catalog')
  await expect(page.getByRole('link', { name: /جمر/ }).first()).toBeVisible({ timeout: 30_000 })
})

const orientations = [
  { name: 'landscape', size: { width: 1194, height: 834 } },
  { name: 'portrait', size: { width: 834, height: 1194 } },
]

for (const o of orientations) {
  test(`walk every screen, ${o.name}`, async () => {
    test.setTimeout(300_000)
    await page.setViewportSize(o.size)
    const r = (globalThis as Record<string, unknown>).qaRoutes as {
      customerId: string
      invoiceId: string
      productId: string
    }
    // the device needs a moment to pull the customer and the invoice
    await go('/customers')
    await expect(page.getByText('محل الفحص').first()).toBeVisible({ timeout: 60_000 })
    const routes = [
      '/',
      '/catalog',
      `/catalog/${r.productId}`,
      '/catalog/new',
      '/customers',
      '/customers/new',
      `/customers/${r.customerId}`,
      `/customers/${r.customerId}/edit`,
      `/customers/${r.customerId}/statement`,
      `/customers/${r.customerId}/payment`,
      `/customers/${r.customerId}/refund`,
      `/customers/${r.customerId}/return`,
      '/invoices',
      `/invoices/${r.invoiceId}`,
      `/invoices/${r.invoiceId}/return`,
      `/checkout/${r.customerId}`,
      '/stock',
      '/reports',
      '/sync',
      '/settings',
      '/settings/business',
      '/settings/categories',
      '/settings/synonyms',
      '/settings/import',
    ]
    for (const route of routes) {
      await go(route)
      const found = await audit(`${o.name} ${route.replace(/[0-9a-f-]{36}/g, ':id')}`)
      problems.push(...found.map((f) => `${f.kind}: ${f.detail}`))
    }
    // the catalog with its filter panel open, and presentation mode with a product open
    await go('/catalog')
    await page.getByRole('button', { name: new RegExp(ar.catalog.filters) }).click()
    problems.push(
      ...(await audit(`${o.name} catalog+filters`)).map((f) => `${f.kind}: ${f.detail}`),
    )
    await go(`/present/${r.customerId}`)
    problems.push(...(await audit(`${o.name} present home`)).map((f) => `${f.kind}: ${f.detail}`))
    await page.getByRole('button', { name: new RegExp(ar.present.all) }).click()
    problems.push(...(await audit(`${o.name} present list`)).map((f) => `${f.kind}: ${f.detail}`))
    await page.getByRole('button', { name: /جمر/ }).first().click()
    problems.push(
      ...(await audit(`${o.name} present product`)).map((f) => `${f.kind}: ${f.detail}`),
    )
    await page.getByRole('button', { name: new RegExp(ar.present.cart) }).click()
    problems.push(...(await audit(`${o.name} present cart`)).map((f) => `${f.kind}: ${f.detail}`))
    await page.getByRole('button', { name: ar.present.close }).click()
    await page.getByRole('button', { name: ar.present.exit }).click()
    problems.push(...(await audit(`${o.name} pin gate`)).map((f) => `${f.kind}: ${f.detail}`))
    await pressPin(PIN)
  })
}
