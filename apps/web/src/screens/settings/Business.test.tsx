import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, wipeLocalData } from '../../db'
import { ar } from '../../i18n/ar'
import { DEFAULT_SETTINGS, loadSettings } from '../../lib/settings'
import { applyPage, type PullPage } from '../../lib/sync/pull'
import Business from './Business'

const emptyPage = (settings?: Record<string, unknown>): PullPage => ({
  changes: {
    categories: [],
    products: [],
    variants: [],
    images: [],
    customers: [],
    invoices: [],
    invoice_lines: [],
    payments: [],
  },
  cursor: 1,
  has_more: false,
  settings,
})

beforeEach(async () => {
  await wipeLocalData()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('settings on the device', () => {
  it('are placeholders until the server sends the real ones', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('come with a pull and are merged over the defaults', async () => {
    await applyPage(emptyPage({ business_name: 'شركة النور', phone: '0568' }))
    expect(await loadSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      business_name: 'شركة النور',
      phone: '0568',
    })
  })

  it('a later pull replaces them', async () => {
    await applyPage(emptyPage({ business_name: 'قديم' }))
    await applyPage(emptyPage({ business_name: 'جديد' }))
    expect((await loadSettings()).business_name).toBe('جديد')
    expect(await db.settings.count()).toBe(1)
  })
})

describe('business details screen', () => {
  const renderScreen = () =>
    render(
      <MemoryRouter>
        <Business />
      </MemoryRouter>,
    )

  it('shows what is saved and sends only the changes the rep makes, then pulls', async () => {
    await applyPage(emptyPage({ business_name: 'شركة النور', phone: '0568' }))
    const calls: { url: string; method?: string; body?: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, method: init?.method, body: init?.body })
        const body = url.includes('/sync/pull')
          ? {
              changes: emptyPage().changes,
              cursor: 1,
              has_more: false,
              settings: { business_name: 'شركة الأمل' },
            }
          : { ...DEFAULT_SETTINGS, business_name: 'شركة الأمل' }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    renderScreen()
    const name = await screen.findByDisplayValue('شركة النور')
    fireEvent.change(name, { target: { value: 'شركة الأمل' } })
    fireEvent.click(screen.getByRole('button', { name: ar.form.save }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url).toContain('/settings')
    expect(JSON.parse(patch.body ?? '{}')).toMatchObject({
      business_name: 'شركة الأمل',
      phone: '0568',
    })
    await waitFor(() => expect(calls.some((c) => c.url.includes('/sync/pull'))).toBe(true))
    expect(await screen.findByText(ar.form.saved)).toBeTruthy()
  })

  it('says it needs the internet when offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    renderScreen()
    expect(await screen.findByText(ar.needsInternet)).toBeTruthy()
  })
})
