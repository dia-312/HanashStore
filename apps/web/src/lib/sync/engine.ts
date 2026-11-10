import { create } from 'zustand'
import { getMeta, setMeta } from '../../db'
import { ApiError } from '../api'
import { runImageQueue } from './images'
import { fetchServerNumbers, raiseCounters } from '../counters'
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
/** The run has asked the server for news (or is past that): its answer cannot hold an edit made now. */
let pulling = false
/** A call joined the run after it had asked for news, so another pull is needed even with nothing to push. */
let stale = false

/**
 * The network event can come before the connection is really back (the radio says yes, the route
 * is not there yet), so the first attempt after it may fail. Waiting for the next minute would
 * leave a sale unsent for no reason: after a "no connection" while the device says it is online,
 * try again after 2, 5, then every 15 seconds, until something else answers.
 */
export const RETRY_MS = [2_000, 5_000, 15_000]
let retryTimer: ReturnType<typeof setTimeout> | undefined
let retryStep = 0

export function stopSyncRetry(): void {
  clearTimeout(retryTimer)
  retryTimer = undefined
  retryStep = 0
}

function scheduleRetry(outcome: Outcome): void {
  clearTimeout(retryTimer)
  retryTimer = undefined
  if (outcome !== 'network' || !navigator.onLine) {
    retryStep = 0
    return
  }
  const delay = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)] ?? 15_000
  retryStep += 1
  retryTimer = setTimeout(() => void syncNow(), delay)
}

/** How a run ended: fine, no connection (worth trying again very soon), or another failure. */
type Outcome = 'ok' | 'network' | 'failed'

/** One push and pull. The reason for a failure is in the store. */
async function runOnce(): Promise<Outcome> {
  try {
    stale = false
    const first = (await getMeta<number>('syncCursor')) === undefined
    const started = performance.now()
    await pushPending()
    pulling = true
    await pullAll()
    // Document numbers continue above the server's (matters on a replacement iPad).
    await raiseCounters(await fetchServerNumbers())
    const now = Date.now()
    await setMeta('lastSyncAt', now)
    useSync.setState({ lastSyncAt: now, lastError: null, firstSyncDone: true })
    if (first) void recordPerf({ firstSyncMs: Math.round(performance.now() - started) })
    void runImageQueue() // after first paint and never awaited: images must not delay anything
    return 'ok'
  } catch (e) {
    if (e instanceof ApiError && e.code === 'DEVICE_REVOKED') hooks.onDeviceRevoked()
    else if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') hooks.onSessionExpired()
    useSync.setState({ lastError: e instanceof ApiError ? e.code : 'UNKNOWN' })
    return e instanceof ApiError && e.code === 'NETWORK' ? 'network' : 'failed'
  } finally {
    pulling = false
  }
}

/**
 * Push waiting commands, then pull. One run at a time. A call made while a run is in progress joins
 * it, and a second round follows at once if a command was added meanwhile (the push had already
 * looked at the outbox) or if the call came after the pull had begun (an edit made online, such as
 * a new category, is not in that answer), so a change never waits for the next minute.
 */
export function syncNow(): Promise<void> {
  if (running) {
    again = true
    if (pulling) stale = true
    return running
  }
  if (!navigator.onLine) return Promise.resolve()
  useSync.setState({ syncing: true })
  running = (async () => {
    try {
      let outcome = await runOnce()
      while (
        outcome === 'ok' &&
        again &&
        navigator.onLine &&
        (stale || (await pendingCount()) > 0)
      ) {
        again = false
        outcome = await runOnce()
      }
      scheduleRetry(outcome)
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
