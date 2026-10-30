import { db } from '../../db'
import { useOnline } from '../online'
import { useLive } from '../useLive'
import { useNow } from '../useNow'
import { syncStatus, useSync } from './engine'

const DAY_MS = 24 * 60 * 60 * 1000

/** Everything the header chip, the sync screen and the 24-hour warning need. */
export function useSyncStatus() {
  const online = useOnline()
  const syncing = useSync((s) => s.syncing)
  const lastError = useSync((s) => s.lastError)
  const now = useNow()
  const counts = useLive(async () => {
    const [pending, rejected, oldest] = await Promise.all([
      db.outbox.where('status').equals('pending').count(),
      db.outbox.where('status').equals('rejected').count(),
      db.outbox.where('status').equals('pending').first(),
    ])
    return { pending, rejected, oldest: oldest ? Date.parse(oldest.created_at) : null }
  }, [])
  const pending = counts?.pending ?? 0
  const rejected = counts?.rejected ?? 0
  return {
    status: syncStatus({ online, syncing, lastError, pending, rejected }),
    pending,
    rejected,
    online,
    lastError,
    pendingTooLong: counts?.oldest != null && now - counts.oldest > DAY_MS,
  }
}
