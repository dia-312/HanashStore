import { create } from 'zustand'
import { getMeta, setMeta } from '../../db'
import { ApiError } from '../api'
import { runImageQueue } from './images'
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

/** Push waiting commands, then pull. One at a time: a call during a run joins that run. */
export function syncNow(): Promise<void> {
  if (running) return running
  if (!navigator.onLine) return Promise.resolve()
  useSync.setState({ syncing: true })
  running = (async () => {
    try {
      await pushPending()
      await pullAll()
      const now = Date.now()
      await setMeta('lastSyncAt', now)
      useSync.setState({ lastSyncAt: now, lastError: null, firstSyncDone: true })
      void runImageQueue() // after first paint and never awaited: images must not delay anything
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DEVICE_REVOKED') hooks.onDeviceRevoked()
      else if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') hooks.onSessionExpired()
      useSync.setState({ lastError: e instanceof ApiError ? e.code : 'UNKNOWN' })
    } finally {
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
