import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  db,
  setMeta,
  wipeLocalData,
  type DbImage,
  type DbProduct,
  type DbVariant,
  type OutboxRow,
} from '../../db'
import { PENDING_COMMANDS, resetAuthStore, useAuth } from '../../store'
import { ApiError } from '../api'
import type { CommandResult, PushResponse } from './commands'
import { effectiveStock, pendingStock } from './effectiveStock'
import { RETRY_MS, setSyncHooks, stopSyncRetry, syncNow, syncStatus, useSync } from './engine'
import { CONCURRENCY, runImageQueue, setImagesPaused, useImages } from './images'
import { discard, enqueue, markRejected, pendingCommands, rejectedCommands, retry } from './outbox'
import { applyPage, pullAll, type PullPage } from './pull'
import { BATCH, CRASH_LIMIT, pushPending } from './push'
import { queueCount, queueDamage, queuePurchase } from './stockCommands'

const variant = (id: string, extra: Partial<DbVariant> = {}): DbVariant => ({
  id,
  product_id: 'p1',
  sku: `SKU-${id}`,
  color: null,
  size: null,
  price: 1000,
  min_stock: 2,
  stock_qty: 10,
  is_active: true,
  change_seq: 1,
  ...extra,
})

const page = (
  partial: Partial<PullPage['changes']>,
  cursor: number,
  hasMore = false,
): PullPage => ({
  changes: {
    categories: [],
    products: [],
    variants: [],
    images: [],
    customers: [],
    invoices: [],
    invoice_lines: [],
    payments: [],
    ...partial,
  },
  cursor,
  has_more: hasMore,
})

const cmd = (type: string, payload: unknown, status: OutboxRow['status'] = 'pending') => ({
  type,
  payload,
  status,
})
const purchase = (id: string, qty: number) =>
  cmd('stock.purchase', { note: null, items: [{ movement_id: 'm', variant_id: id, qty }] })
const damage = (id: string, qty: number) =>
  cmd('stock.damage', { movement_id: 'm', variant_id: id, qty, note: 'x' })
const adjust = (id: string, counted: number) =>
  cmd('stock.adjust', {
    movement_id: 'm',
    variant_id: id,
    counted_qty: counted,
    expected_qty: 0,
    note: 'x',
  })

beforeEach(async () => {
  stopSyncRetry()
  await wipeLocalData()
  await setMeta('identity', { user: { id: 'u', name: 'Rep' }, device: { id: 'd1', name: 'iPad' } })
  resetAuthStore()
  useSync.setState({ syncing: false, lastSyncAt: null, lastError: null, firstSyncDone: false })
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('effective stock', () => {
  const base = new Map([['a', 10]])

  it('adds purchases and takes away write-offs in the order they were made', () => {
    const result = pendingStock(base, [purchase('a', 5), damage('a', 3)])
    expect(result.get('a')).toBe(12)
  })

  it('a count sets the quantity, and later commands build on it', () => {
    expect(pendingStock(base, [adjust('a', 4), purchase('a', 1)]).get('a')).toBe(5)
    expect(pendingStock(base, [purchase('a', 5), adjust('a', 4)]).get('a')).toBe(4)
  })

  it('a write-off the server would refuse changes nothing', () => {
    expect(pendingStock(base, [damage('a', 11)]).get('a')).toBeUndefined()
    expect(pendingStock(base, [damage('a', 6), damage('a', 6)]).get('a')).toBe(4)
  })

  it('rejected commands are left out, which is how a rejection undoes itself on screen', () => {
    const rejected = { ...purchase('a', 99), status: 'rejected' as const }
    expect(effectiveStock('a', 10, [rejected])).toBe(10)
  })

  it('ignores variants it does not know and returns only what was touched', () => {
    expect(pendingStock(base, [purchase('zzz', 1)]).size).toBe(0)
    expect(effectiveStock('a', 10, [])).toBe(10)
  })
})

describe('sync status', () => {
  const ok = { online: true, syncing: false, lastError: null, pending: 0, rejected: 0 }
  it.each([
    [{}, 'synced'],
    [{ pending: 3 }, 'pending'],
    [{ syncing: true }, 'syncing'],
    [{ online: false, pending: 3 }, 'offline'],
    [{ lastError: 'HTTP_ERROR' }, 'error'],
    [{ rejected: 1 }, 'error'],
  ])('%j -> %s', (change, expected) => {
    expect(syncStatus({ ...ok, ...change })).toBe(expected)
  })
})

describe('outbox', () => {
  it('keeps commands in the order they were made', async () => {
    const a = await enqueue('stock.damage', { variant_id: 'a' })
    const b = await enqueue('stock.damage', { variant_id: 'b' })
    expect((await pendingCommands()).map((c) => c.id)).toEqual([a.id, b.id])
    expect(a.schema_version).toBe(1)
  })

  it('a rejected command leaves the pending list but stays for the rep to see', async () => {
    const a = await enqueue('stock.damage', { variant_id: 'a' })
    await markRejected(a.id, { code: 'INSUFFICIENT_STOCK', message: 'm', details: {} })
    expect(await pendingCommands()).toHaveLength(0)
    expect((await rejectedCommands())[0]?.error?.code).toBe('INSUFFICIENT_STOCK')
  })

  it('retry makes a new command id and puts it at the back; discard removes it', async () => {
    const a = await enqueue('stock.damage', { variant_id: 'a' })
    await markRejected(a.id, { code: 'X', message: 'm', details: {} })
    const b = await enqueue('stock.damage', { variant_id: 'b' })
    await retry(a.id)
    const pending = await pendingCommands()
    expect(pending).toHaveLength(2)
    expect(pending[0]?.id).toBe(b.id)
    expect(pending[1]?.id).not.toBe(a.id)
    expect(pending[1]?.payload).toEqual({ variant_id: 'a' })
    await discard(b.id)
    expect(await pendingCommands()).toHaveLength(1)
  })
})

describe('pull', () => {
  it('applies a page and moves the cursor in one go', async () => {
    await applyPage(page({ variants: [variant('a'), variant('b')] }, 7))
    expect(await db.variants.count()).toBe(2)
    expect((await db.meta.get('syncCursor'))?.value).toBe(7)
  })

  it('does not overwrite a row with an older change_seq', async () => {
    await applyPage(page({ variants: [variant('a', { stock_qty: 50, change_seq: 9 })] }, 9))
    await applyPage(page({ variants: [variant('a', { stock_qty: 1, change_seq: 4 })] }, 9))
    expect((await db.variants.get('a'))?.stock_qty).toBe(50)
    await applyPage(page({ variants: [variant('a', { stock_qty: 7, change_seq: 12 })] }, 12))
    expect((await db.variants.get('a'))?.stock_qty).toBe(7)
  })

  it('keeps asking until the server has nothing more, then stops', async () => {
    const seen: number[] = []
    const pages = [
      page({ variants: [variant('a')] }, 5, true),
      page({ variants: [variant('b')] }, 9, true),
      page({ variants: [variant('c')] }, 12, false),
    ]
    const rows = await pullAll(async (cursor) => {
      seen.push(cursor)
      return pages[seen.length - 1]!
    })
    expect(seen).toEqual([0, 5, 9])
    expect(rows).toBe(3)
    expect(await db.variants.count()).toBe(3)
  })

  it('does not loop forever when a page says there is more but moves nowhere', async () => {
    let calls = 0
    await pullAll(async () => {
      calls++
      return page({}, 0, true)
    })
    expect(calls).toBe(1)
  })

  it('stores deactivated and removed rows so the device learns about them', async () => {
    const product: DbProduct = {
      id: 'p1',
      category_id: 'c',
      name: 'x',
      description: null,
      search_text: 'x',
      is_active: false,
      change_seq: 3,
    }
    const image: DbImage = {
      id: 'i1',
      product_id: 'p1',
      variant_id: null,
      thumb_url: '/media/t.webp',
      full_url: '/media/f.webp',
      sort_order: 0,
      deleted_at: '2026-11-01T00:00:00Z',
      change_seq: 3,
    }
    await applyPage(page({ products: [product], images: [image] }, 3))
    expect((await db.products.get('p1'))?.is_active).toBe(false)
    expect((await db.images.get('i1'))?.deleted_at).not.toBeNull()
  })
})

describe('push', () => {
  const applied = (id: string, stock: number, seq: number): CommandResult => ({
    id,
    status: 'applied',
    data: { applied: 1, variants: [{ id: 'a', stock_qty: stock, change_seq: seq }] },
  })

  it('an applied command leaves the outbox and its new quantity lands at the same time', async () => {
    await db.variants.put(variant('a', { stock_qty: 10, change_seq: 1 }))
    const command = await enqueue('stock.purchase', {
      note: null,
      items: [{ movement_id: 'm', variant_id: 'a', qty: 5 }],
    })
    const send = vi.fn(async (): Promise<PushResponse> => ({
      results: [applied(command.id, 15, 6)],
      cursor: 6,
    }))
    expect(await pushPending(send)).toBe(1)
    expect(await pendingCommands()).toHaveLength(0)
    const row = await db.variants.get('a')
    expect([row?.stock_qty, row?.change_seq]).toEqual([15, 6])
    expect(send).toHaveBeenCalledWith('d1', [expect.objectContaining({ id: command.id })])
  })

  it('a rejected command stays, marked, and does not touch the quantity', async () => {
    await db.variants.put(variant('a', { stock_qty: 3 }))
    const command = await enqueue('stock.damage', {
      movement_id: 'm',
      variant_id: 'a',
      qty: 9,
      note: 'x',
    })
    await pushPending(async () => ({
      results: [
        {
          id: command.id,
          status: 'rejected',
          error: { code: 'INSUFFICIENT_STOCK', message: 'm', details: { available: 3 } },
        },
      ],
      cursor: 1,
    }))
    expect((await rejectedCommands())[0]?.error?.details.available).toBe(3)
    expect((await db.variants.get('a'))?.stock_qty).toBe(3)
  })

  it('sends at most 50 commands per request, oldest first', async () => {
    for (let i = 0; i < 120; i++) await enqueue('stock.damage', { variant_id: 'a', n: i })
    const sizes: number[] = []
    await pushPending(async (_device, commands) => {
      sizes.push(commands.length)
      return {
        results: commands.map((c) => ({ id: c.id, status: 'applied' as const })),
        cursor: 1,
      }
    })
    expect(sizes).toEqual([BATCH, BATCH, 20])
    expect(await pendingCommands()).toHaveLength(0)
  })

  it('stops when the server answers for none of them instead of sending forever', async () => {
    await enqueue('stock.damage', { variant_id: 'a' })
    const send = vi.fn(async (): Promise<PushResponse> => ({ results: [], cursor: 1 }))
    await pushPending(send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(await pendingCommands()).toHaveLength(1)
  })

  describe('a command the server cannot take at all', () => {
    const okFor = (commands: { id: string }[]): PushResponse => ({
      results: commands.map((c) => ({ id: c.id, status: 'applied' as const })),
      cursor: 1,
    })
    const crashOn = (id: string) => async (_device: string, commands: { id: string }[]) => {
      if (commands.some((c) => c.id === id)) throw new ApiError(500, 'HTTP_ERROR', 'Server Error')
      return okFor(commands)
    }

    it('a request the server cannot read (422) is set aside at once; the others go through', async () => {
      const first = await enqueue('stock.damage', { variant_id: 'a', n: 1 })
      const bad = await enqueue('stock.damage', { variant_id: 'a', n: 2 })
      const last = await enqueue('stock.damage', { variant_id: 'a', n: 3 })
      const sent: string[][] = []
      const handled = await pushPending(async (_device, commands) => {
        sent.push(commands.map((c) => c.id))
        if (commands.some((c) => c.id === bad.id)) {
          throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid input')
        }
        return okFor(commands)
      })
      expect(handled).toBe(3)
      expect(await pendingCommands()).toHaveLength(0)
      const refused = await rejectedCommands()
      expect(refused.map((c) => c.id)).toEqual([bad.id])
      expect(refused[0]?.error).toMatchObject({ code: 'REQUEST_REFUSED', details: { status: 422 } })
      // the whole batch once, then one by one
      expect(sent[0]).toEqual([first.id, bad.id, last.id])
      expect(sent.slice(1)).toEqual([[first.id], [bad.id], [last.id]])
    })

    it('a crash (500) is tried again: the ones before it go through, it and the rest wait in order', async () => {
      const first = await enqueue('stock.damage', { variant_id: 'a', n: 1 })
      const toxic = await enqueue('stock.damage', { variant_id: 'a', n: 2 })
      const last = await enqueue('stock.damage', { variant_id: 'a', n: 3 })
      await expect(pushPending(crashOn(toxic.id))).rejects.toMatchObject({ status: 500 })
      expect((await pendingCommands()).map((c) => c.id)).toEqual([toxic.id, last.id])
      expect(await rejectedCommands()).toHaveLength(0)
      expect(first.id).toBeTruthy()
    })

    it(`after ${CRASH_LIMIT} crashes in a row on that command alone it is set aside and the rest go`, async () => {
      const toxic = await enqueue('stock.damage', { variant_id: 'a', n: 1 })
      const last = await enqueue('stock.damage', { variant_id: 'a', n: 2 })
      for (let run = 1; run < CRASH_LIMIT; run++) {
        await expect(pushPending(crashOn(toxic.id))).rejects.toMatchObject({ status: 500 })
        expect(await pendingCommands()).toHaveLength(2)
      }
      await pushPending(crashOn(toxic.id))
      expect((await rejectedCommands()).map((c) => c.id)).toEqual([toxic.id])
      expect((await rejectedCommands())[0]?.error).toMatchObject({ code: 'SERVER_ERROR' })
      expect(await pendingCommands()).toHaveLength(0)
      expect(last.id).toBeTruthy()
    })

    it('the rep can try a set-aside command again: it gets a new id and goes back to waiting', async () => {
      const bad = await enqueue('stock.damage', { variant_id: 'a' })
      await pushPending(async () => {
        throw new ApiError(422, 'VALIDATION_ERROR', 'x')
      })
      await retry(bad.id)
      expect(await rejectedCommands()).toHaveLength(0)
      expect(await pendingCommands()).toHaveLength(1)
    })

    it.each([
      ['no connection', new ApiError(0, 'NETWORK', 'No connection')],
      ['an expired session', new ApiError(401, 'UNAUTHENTICATED', 'Login required')],
      ['a revoked device', new ApiError(401, 'DEVICE_REVOKED', 'revoked')],
      ['a busy gateway', new ApiError(502, 'HTTP_ERROR', 'Bad Gateway')],
      ['a closed gate', new ApiError(503, 'DB_DOWN', 'Database unreachable')],
      ['too many tries', new ApiError(429, 'RATE_LIMITED', 'slow down')],
    ])('%s leaves every command waiting and is passed on', async (_name, error) => {
      await enqueue('stock.damage', { variant_id: 'a', n: 1 })
      await enqueue('stock.damage', { variant_id: 'a', n: 2 })
      await expect(
        pushPending(async () => {
          throw error
        }),
      ).rejects.toBe(error)
      expect(await pendingCommands()).toHaveLength(2)
      expect(await rejectedCommands()).toHaveLength(0)
    })
  })

  it('nothing is sent when there is nothing pending', async () => {
    const send = vi.fn()
    expect(await pushPending(send)).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('stock commands (what the screens call)', () => {
  beforeEach(async () => {
    // Offline, so queueing does not start a real send.
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    await db.variants.bulkPut([variant('a', { stock_qty: 10 }), variant('b', { stock_qty: 0 })])
  })

  it('a stock-in is saved on the device first and shows the new quantity at once', async () => {
    const result = await queuePurchase('مورد', [
      { movementId: 'm1', variantId: 'a', qty: 5 },
      { movementId: 'm2', variantId: 'b', qty: 3 },
    ])
    expect(Object.fromEntries(result.variants.map((v) => [v.id, v.stock_qty]))).toEqual({
      a: 15,
      b: 3,
    })
    expect(await pendingCommands()).toHaveLength(1)
  })

  it('damage and count build on each other and on the stock-in', async () => {
    await queuePurchase(null, [{ movementId: 'm1', variantId: 'a', qty: 5 }])
    const damaged = await queueDamage({ movementId: 'm2', variantId: 'a', qty: 3, note: 'x' })
    expect(damaged.variants[0]?.stock_qty).toBe(12)
    const counted = await queueCount({
      movementId: 'm3',
      variantId: 'a',
      counted: 20,
      expected: 12,
      note: 'x',
    })
    expect(counted.variants[0]?.stock_qty).toBe(20)
    expect(await pendingCommands()).toHaveLength(3)
  })
})

describe('sync engine', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('does nothing without a network, and keeps the commands', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    await enqueue('stock.damage', { variant_id: 'a' })
    await syncNow()
    expect(fetchStub).not.toHaveBeenCalled()
    expect(await pendingCommands()).toHaveLength(1)
  })

  it('pushes first and then pulls, and remembers when it last worked', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        calls.push(input)
        if (input.includes('/sync/push')) return json({ results: [], cursor: 0 })
        return json(page({ variants: [variant('a')] }, 4))
      }),
    )
    await enqueue('stock.damage', { variant_id: 'a' })
    await syncNow()
    expect(calls[0]).toContain('/sync/push')
    expect(calls.some((c) => c.includes('/sync/pull?cursor=0'))).toBe(true)
    expect(useSync.getState().lastError).toBeNull()
    expect(useSync.getState().firstSyncDone).toBe(true)
    expect(useSync.getState().lastSyncAt).not.toBeNull()
    expect(await db.variants.count()).toBe(1)
  })

  it('a call during a run joins it: one run at a time', async () => {
    const fetchStub = vi.fn<(url: string) => Promise<Response>>(async () => json(page({}, 0)))
    vi.stubGlobal('fetch', fetchStub)
    await Promise.all([syncNow(), syncNow(), syncNow()])
    // One pull and the numbers check, no push (nothing pending), however many callers there were.
    expect(
      fetchStub.mock.calls.map(([url]) => String(url)).filter((u) => u.includes('/sync/pull')),
    ).toHaveLength(1)
    expect(
      fetchStub.mock.calls.map(([url]) => String(url)).filter((u) => u.includes('/sync/push')),
    ).toHaveLength(0)
  })

  it('a command made while a run is under way is sent in a second round, not a minute later', async () => {
    const pushed: string[][] = []
    let pulls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: { body?: string }) => {
        if (input.includes('/sync/push')) {
          const commands = (JSON.parse(init?.body ?? '{}') as { commands: { id: string }[] })
            .commands
          pushed.push(commands.map((c) => c.id))
          return json({
            results: commands.map((c) => ({ id: c.id, status: 'applied' })),
            cursor: 1,
          })
        }
        pulls++
        if (pulls === 1) {
          // The rep confirms a stock-in right now, after this run already looked at the outbox.
          await enqueue('stock.damage', { variant_id: 'late' })
          void syncNow()
        }
        return json(page({}, 0))
      }),
    )
    const first = await enqueue('stock.damage', { variant_id: 'early' })
    await syncNow()
    expect(pushed).toHaveLength(2)
    expect(pushed[0]).toEqual([first.id])
    expect(pushed[1]).toHaveLength(1)
    expect(await pendingCommands()).toHaveLength(0)
  })

  it('a server error is shown, keeps the commands, and the next run tries again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ code: 'INTERNAL', message: 'boom', details: {} }, 500)),
    )
    await enqueue('stock.damage', { variant_id: 'a' })
    await syncNow()
    expect(useSync.getState().lastError).toBe('INTERNAL')
    expect(await pendingCommands()).toHaveLength(1)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ...page({}, 0), results: [] })),
    )
    await syncNow()
    expect(useSync.getState().lastError).toBeNull()
  })

  it('tells the app when the session is gone or the device was revoked', async () => {
    const hooks = { onSessionExpired: vi.fn(), onDeviceRevoked: vi.fn() }
    setSyncHooks(hooks)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ code: 'UNAUTHENTICATED', message: 'x', details: {} }, 401)),
    )
    await syncNow()
    expect(hooks.onSessionExpired).toHaveBeenCalled()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ code: 'DEVICE_REVOKED', message: 'x', details: {} }, 401)),
    )
    await syncNow()
    expect(hooks.onDeviceRevoked).toHaveBeenCalled()
    setSyncHooks({ onSessionExpired: () => undefined, onDeviceRevoked: () => undefined })
  })

  it('a lost connection mid-run is not an error the rep must act on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('network'))),
    )
    await syncNow()
    expect(useSync.getState().lastError).toBe(new ApiError(0, 'NETWORK', '').code)
  })
})

describe('trying again soon after a lost connection', () => {
  const failing = () =>
    vi.fn(async () => {
      throw new TypeError('network')
    })
  const answering = () =>
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            changes: { categories: [], products: [], variants: [], images: [] },
            cursor: 1,
            has_more: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )

  afterEach(() => {
    stopSyncRetry()
    vi.useRealTimers()
  })

  it('a failed run while the device says it is online is repeated after 2, then 5, then 15 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setTimeout', 'clearTimeout'] })
    const fetchStub = failing()
    vi.stubGlobal('fetch', fetchStub)
    await syncNow()
    const calls = () => fetchStub.mock.calls.length
    const first = calls()
    expect(first).toBeGreaterThan(0)
    for (const wait of [...RETRY_MS, 15_000]) {
      await vi.advanceTimersByTimeAsync(wait - 1)
      const before = calls()
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(calls()).toBeGreaterThan(before))
    }
  })

  it('the first run that gets through ends the retrying', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('fetch', failing())
    await syncNow()
    const working = answering()
    vi.stubGlobal('fetch', working)
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]!)
    await vi.waitFor(() => expect(useSync.getState().lastError).toBeNull())
    const done = working.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(working.mock.calls.length).toBe(done) // nothing more is scheduled
  })

  it('offline, and after a server error, nothing is scheduled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setTimeout', 'clearTimeout'] })
    const serverError = vi.fn(
      async () =>
        new Response('{"code":"INTERNAL"}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', serverError)
    await syncNow()
    const after = serverError.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(serverError.mock.calls.length).toBe(after)

    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    await syncNow()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(serverError.mock.calls.length).toBe(after)
  })
})

describe('logout', () => {
  it('is refused while commands wait in the outbox, and nothing is sent or wiped', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    await enqueue('stock.damage', { variant_id: 'a' })
    await expect(useAuth.getState().logout()).rejects.toThrow(PENDING_COMMANDS)
    await expect(useAuth.getState().logoutAll()).rejects.toThrow(PENDING_COMMANDS)
    expect(fetchStub).not.toHaveBeenCalled()
    expect(await pendingCommands()).toHaveLength(1)
  })
})

describe('Dexie upgrade', () => {
  it('version 1 data (the login record) survives the move to version 2', async () => {
    await db.delete()
    const old = new Dexie('sales-rep')
    old.version(1).stores({ meta: 'key' })
    await old.open()
    await old.table('meta').put({ key: 'identity', value: { device: { id: 'keep-me' } } })
    old.close()

    await db.open()
    expect((await db.meta.get('identity'))?.value).toEqual({ device: { id: 'keep-me' } })
    await enqueue('stock.damage', { variant_id: 'a' }) // the new tables work
    expect(await pendingCommands()).toHaveLength(1)
  })
})

describe('image queue', () => {
  const addImages = async (n: number) => {
    await db.products.put({
      id: 'p1',
      category_id: 'c',
      name: 'x',
      description: null,
      search_text: 'x',
      is_active: true,
      change_seq: 1,
    })
    await db.images.bulkPut(
      Array.from({ length: n }, (_, i) => ({
        id: `i${i}`,
        product_id: 'p1',
        variant_id: null,
        thumb_url: `/media/t${i}.webp`,
        full_url: `/media/f${i}.webp`,
        sort_order: i,
        deleted_at: null,
        change_seq: 1,
      })),
    )
  }

  beforeEach(() => {
    vi.stubGlobal('caches', {
      open: async () => ({ keys: async () => [] }),
      keys: async () => [],
      delete: async () => true,
    })
    setImagesPaused(false)
  })

  it('downloads every thumbnail and full image once, never more than four at a time', async () => {
    await addImages(10)
    let inFlight = 0
    let peak = 0
    const downloaded: string[] = []
    await runImageQueue({
      online: () => true,
      download: async (url) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inFlight--
        downloaded.push(url)
      },
    })
    expect(downloaded).toHaveLength(20)
    expect(new Set(downloaded).size).toBe(20)
    expect(peak).toBeLessThanOrEqual(CONCURRENCY)
    expect(peak).toBeGreaterThan(1)
    expect(downloaded.slice(0, 10).every((u) => u.includes('/t'))).toBe(true) // thumbnails first
    expect(useImages.getState().running).toBe(false)
  })

  it('skips deleted images and images of stopped products', async () => {
    await addImages(2)
    await db.images.update('i0', { deleted_at: '2026-11-01T00:00:00Z' })
    const downloaded: string[] = []
    await runImageQueue({ online: () => true, download: async (u) => void downloaded.push(u) })
    expect(downloaded.sort()).toEqual(['/media/f1.webp', '/media/t1.webp'])
    await db.products.update('p1', { is_active: false })
    const again: string[] = []
    await runImageQueue({ online: () => true, download: async (u) => void again.push(u) })
    expect(again).toEqual([])
  })

  it('does nothing offline or while paused (checkout), and carries on afterwards', async () => {
    await addImages(3)
    const download = vi.fn(async () => undefined)
    await runImageQueue({ online: () => false, download })
    setImagesPaused(true)
    await runImageQueue({ online: () => true, download })
    expect(download).not.toHaveBeenCalled()
    setImagesPaused(false)
    await runImageQueue({ online: () => true, download })
    expect(download).toHaveBeenCalledTimes(6)
  })

  it('one failed image does not stop the others', async () => {
    await addImages(3)
    const done: string[] = []
    await runImageQueue({
      online: () => true,
      download: async (url) => {
        if (url.endsWith('t1.webp')) throw new Error('nope')
        done.push(url)
      },
    })
    expect(done).toHaveLength(5)
  })
})
