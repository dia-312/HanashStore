import { useMemo } from 'react'
import { getMeta } from '../db'
import { ar } from '../i18n/ar'
import { getClockSkewMs } from './api'
import { useSync } from './sync/engine'

// Every document carries the date of the iPad's clock (SPEC section 7). A clock that is wrong would
// put a sale in the wrong month of every statement and report, so while it is plainly wrong no new
// document is made, and the screen says why. The server refuses absurd dates as a last resort.

export const CLOCK_LIMIT_MS = 5 * 60_000

/** The last server answer says the clock is more than five minutes off. */
export const skewTooBig = (skew: number | null) => skew !== null && Math.abs(skew) > CLOCK_LIMIT_MS

/**
 * True when there is evidence the clock is wrong: the server's time differs from the device's by
 * more than five minutes (measured on every answer), or the device is earlier than its own last
 * successful sync (the clock was moved back). Offline with no evidence, nothing is blocked.
 */
export async function clockLooksWrong(now = Date.now()): Promise<boolean> {
  if (skewTooBig(getClockSkewMs())) return true
  const lastSyncAt = await getMeta<number>('lastSyncAt')
  return lastSyncAt !== undefined && now < lastSyncAt - CLOCK_LIMIT_MS
}

/** For screens: the same check, redone after every sync. */
export function useClockWrong(): boolean {
  const lastSyncAt = useSync((s) => s.lastSyncAt)
  // lastSyncAt only says "a sync just ended": that is when the server's time was read again.
  return useMemo(() => {
    void lastSyncAt
    return skewTooBig(getClockSkewMs())
  }, [lastSyncAt])
}

/** The text for a failed write: the clock's own message when that is why, else the screen's. */
export const clockAware = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message === 'CLOCK_OFF' ? ar.errors.clockOff : fallback
