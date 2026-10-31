import { create } from 'zustand'
import { getMeta, setMeta } from '../../db'
import { ApiError } from '../api'
import { runImageQueue } from './images'
import { recordPerf } from '../perf'
import { pendingCount } from './outbox'
import { pullAll } from './pull'
import { pushPending } from './push'

export type SyncStatus = 'synced' | 'pending' | 'syncing' | 'offline' | 'error'

interface SyncState {
  syncing: boolean
  lastSyncAt: number | null
  /** Code of the last failed attempt; cleared by the next success. */
  lastError: string | null
  /** The first pull finished at least once on this device. */
  firstSyncDone: boolean
}

export const useSync = create<SyncState>()(() => ({
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  firstSyncDone: false,
}))

/** What the header shows (SPEC section 8): synced, N pending, offline, or an error. */
export function syncStatus(input: {
  online: boolean
  syncing: boolean
  lastError: string | null
  pending: number
  rejected: number
}): SyncStatus {
  if (!input.online) return 'offline'
  if (input.lastError !== null || input.rejected > 0) return 'error'
  if (input.syncing) return 'syncing'
  return input.pending > 0 ? 'pending' : 'synced'
}

export interface SyncHooks {
  /** The server says the session is gone; the outbox is kept. */
  onSessionExpired: () => void
  /** The server says this device was revoked: everything is wiped. */
  onDeviceRevoked: () => void
}

let hooks: SyncHooks = { onSessionExpired: () => undefined, onDeviceRevoked: () => undefined }
export const setSyncHooks = (next: SyncHooks) => {
  hooks = next
}

let running: Promise<void> | null = null
let again = false

/** One push and pull. Returns false when it failed (the reason is in the store). */
async function runOnce(): Promise<boolean> {
  try {
    const first = (await getMeta<number>('syncCursor')) === undefined
    const started = performance.now()
    await pushPending()
    await pullAll()
    const now = Date.now()
    await setMeta('lastSyncAt', now)
    useSync.setState({ lastSyncAt: now, lastError: null, firstSyncDone: true })
    if (first) void recordPerf({ firstSyncMs: Math.round(performance.now() - started) })
    void runImageQueue() // after first paint and never awaited: images must not delay anything
    return true
  } catch (e) {
    if (e instanceof ApiError && e.code === 'DEVICE_REVOKED') hooks.onDeviceRevoked()
    else if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') hooks.onSessionExpired()
    useSync.setState({ lastError: e instanceof ApiError ? e.code : 'UNKNOWN' })
    return false
  }
}

/**
 * Push waiting commands, then pull. One run at a time. A call made while a run is in progress joins
 * it, and if a command was added meanwhile (the push had already looked at the outbox) a second
 * round follows at once, so a change never waits for the next minute.
 */
export function syncNow(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  if (!navigator.onLine) return Promise.resolve()
  useSync.setState({ syncing: true })
  running = (async () => {
    try {
      let ok = await runOnce()
      while (ok && again && navigator.onLine && (await pendingCount()) > 0) {
        again = false
        ok = await runOnce()
      }
    } finally {
      again = false
      useSync.setState({ syncing: false })
      running = null
    }
  })()
  return running
}

export const SYNC_EVERY_MS = 60_000

/** Starts the sync triggers: now, when the network returns, when the app comes back to the front,
 * and every minute while it is open (iOS has no background sync). Returns the cleanup. */
export function startSyncLoop(): () => void {
  void (async () => {
    const [lastSyncAt, cursor] = await Promise.all([
      getMeta<number>('lastSyncAt'),
      getMeta<number>('syncCursor'),
    ])
    useSync.setState({ lastSyncAt: lastSyncAt ?? null, firstSyncDone: cursor !== undefined })
  })()
  const trigger = () => void syncNow()
  const visible = () => document.visibilityState === 'visible' && trigger()
  const first = setTimeout(trigger, 0)
  const timer = setInterval(
    () => document.visibilityState === 'visible' && trigger(),
    SYNC_EVERY_MS,
  )
  window.addEventListener('online', trigger)
  document.addEventListener('visibilitychange', visible)
  return () => {
    clearTimeout(first)
    clearInterval(timer)
    window.removeEventListener('online', trigger)
    document.removeEventListener('visibilitychange', visible)
  }
}
