import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setMeta, wipeLocalData } from '../../db'
import { readPerf } from '../perf'
import { syncNow, useSync } from './engine'
import { useSyncOnOpen } from './useSyncOnOpen'

const emptyPage = {
  changes: { categories: [], products: [], variants: [], images: [] },
  cursor: 0,
  has_more: false,
}

beforeEach(async () => {
  await wipeLocalData()
  await setMeta('identity', { user: { id: 'u', name: 'Rep' }, device: { id: 'd1', name: 'iPad' } })
  useSync.setState({ syncing: false, lastSyncAt: null, lastError: null, firstSyncDone: false })
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('opening a screen that shows stock asks the server for what changed', async () => {
  const fetchStub = vi.fn<(url: string) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify(emptyPage), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetchStub)
  renderHook(() => useSyncOnOpen())
  await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1))
  expect(String(fetchStub.mock.calls[0]?.[0])).toContain('/sync/pull')
})

it('the duration of the first sync on a device is kept for Settings', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(emptyPage), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  )
  await syncNow()
  await waitFor(async () => expect(typeof (await readPerf())?.firstSyncMs).toBe('number'))
})
