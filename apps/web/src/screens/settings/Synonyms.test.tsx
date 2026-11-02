import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, wipeLocalData } from '../../db'
import { ar } from '../../i18n/ar'
import { buildProductList, loadSnapshot } from '../../lib/localCatalog'
import { applyPage, type PullPage } from '../../lib/sync/pull'
import Synonyms from './Synonyms'

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

interface Call {
  url: string
  method?: string
  body?: string
}

/** A server with two groups; PUT answers with the list it was given, ids filled in. */
const stubServer = (calls: Call[]) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method, body: init?.body })
      if (init?.method === 'PUT') {
        const groups = (
          JSON.parse(init.body ?? '{}') as { groups: { id?: string; terms: string[] }[] }
        ).groups
        return json(groups.map((g, i) => ({ id: g.id ?? `new-${i}`, terms: g.terms })))
      }
      if (url.includes('/sync/pull')) {
        return json({
          changes: { categories: [], products: [], variants: [], images: [], customers: [] },
          cursor: 0,
          has_more: false,
        })
      }
      return json([
        { id: 'g1', terms: ['فحم', 'فحمات'] },
        { id: 'g2', terms: ['راس', 'حجر'] },
      ])
    }),
  )

const renderScreen = () =>
  render(
    <MemoryRouter>
      <Synonyms />
    </MemoryRouter>,
  )

beforeEach(async () => {
  await wipeLocalData()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('synonyms screen', () => {
  it('shows each group on a line and saves the whole list, keeping the ids of the old ones', async () => {
    const calls: Call[] = []
    stubServer(calls)
    renderScreen()
    const first = await screen.findByDisplayValue('فحم، فحمات')
    fireEvent.change(first, { target: { value: 'فحم, فحمات، كربون' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ar.synonyms.add) }))
    const boxes = screen.getAllByRole('textbox', { name: ar.synonyms.words })
    fireEvent.change(boxes[2]!, { target: { value: 'ماسك، مبسم' } })
    fireEvent.click(screen.getByRole('button', { name: ar.synonyms.save }))
    expect(await screen.findByText(ar.synonyms.saved)).toBeTruthy()
    const put = calls.find((c) => c.method === 'PUT')!
    expect(JSON.parse(put.body ?? '{}')).toEqual({
      groups: [
        { id: 'g1', terms: ['فحم', 'فحمات', 'كربون'] },
        { id: 'g2', terms: ['راس', 'حجر'] },
        { terms: ['ماسك', 'مبسم'] },
      ],
    })
  })

  it('refuses a line with fewer than two different words, and drops an empty line', async () => {
    const calls: Call[] = []
    stubServer(calls)
    renderScreen()
    const second = await screen.findByDisplayValue('راس، حجر')
    fireEvent.change(second, { target: { value: 'رأس، راس' } }) // the same word once normalized
    expect(await screen.findByText(ar.synonyms.needTwo)).toBeTruthy()
    const save = screen.getByRole('button', { name: ar.synonyms.save }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(second, { target: { value: '' } }) // an empty line is just removed
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await screen.findByText(ar.synonyms.saved)
    const put = calls.find((c) => c.method === 'PUT')!
    expect(JSON.parse(put.body ?? '{}').groups).toEqual([{ id: 'g1', terms: ['فحم', 'فحمات'] }])
  })

  it('a group can be removed', async () => {
    const calls: Call[] = []
    stubServer(calls)
    renderScreen()
    await screen.findByDisplayValue('فحم، فحمات')
    fireEvent.click(screen.getAllByRole('button', { name: ar.synonyms.remove })[0]!)
    fireEvent.click(screen.getByRole('button', { name: ar.synonyms.save }))
    await screen.findByText(ar.synonyms.saved)
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body ?? '{}').groups).toEqual([
      { id: 'g2', terms: ['راس', 'حجر'] },
    ])
  })

  it('says it needs the internet when offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    renderScreen()
    expect(await screen.findByText(ar.needsInternet)).toBeTruthy()
  })
})

describe('synonyms on the device', () => {
  const page = (synonym_groups: PullPage['changes']['synonym_groups']): PullPage => ({
    changes: {
      categories: [{ id: 'c', name: 'أراجيل', sort_order: 0, is_active: true, change_seq: 1 }],
      synonym_groups,
      products: [
        {
          id: 'p',
          category_id: 'c',
          name: 'أرجيلة كبيرة',
          description: null,
          search_text: '',
          is_active: true,
          change_seq: 1,
        },
      ],
      variants: [],
      images: [],
      customers: [],
      invoices: [],
      invoice_lines: [],
      payments: [],
    },
    cursor: 1,
    has_more: false,
  })

  it('arrive with a pull, make search find the other words, and switching one off removes it', async () => {
    const find = async () => buildProductList(await loadSnapshot(), { q: 'شيشة' }).length
    await applyPage(page(undefined)) // an older server sends none
    expect(await find()).toBe(0)
    await applyPage(page([{ id: 'g', terms: ['ارجيله', 'شيشه'], is_active: true, change_seq: 2 }]))
    expect(await db.synonym_groups.count()).toBe(1)
    expect(await find()).toBe(1)
    await applyPage(page([{ id: 'g', terms: ['ارجيله', 'شيشه'], is_active: false, change_seq: 3 }]))
    expect(await find()).toBe(0)
  })
})
