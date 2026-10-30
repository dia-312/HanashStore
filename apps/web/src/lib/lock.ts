// Pure rules for the app lock (SPEC F1, section 13). No timers or storage here, so they are easy to test.

export const IDLE_LIMIT_MS = 5 * 60_000
export const BACKGROUND_LIMIT_MS = 5 * 60_000
export const MAX_WRONG_PINS = 5
/** Offline lockout after each round of 5 wrong PINs: 1, then 5, then 15 minutes (and 15 from then on). */
export const OFFLINE_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000]

export interface PinAttempts {
  /** Wrong PINs in the current round. */
  failures: number
  /** Completed rounds of 5 wrong PINs while offline. */
  rounds: number
  /** Epoch ms until which PIN entry is refused, or null. */
  lockedUntil: number | null
  /** Online, 5 wrong PINs demand the full password instead of more PIN tries. */
  requirePassword: boolean
}

export const freshAttempts = (): PinAttempts => ({
  failures: 0,
  rounds: 0,
  lockedUntil: null,
  requirePassword: false,
})

export const idleExpired = (lastActive: number, now: number) => now - lastActive >= IDLE_LIMIT_MS

export const backgroundExpired = (hiddenAt: number, now: number) =>
  now - hiddenAt >= BACKGROUND_LIMIT_MS

export function remainingLockMs(a: PinAttempts, now: number): number {
  return a.lockedUntil ? Math.max(0, a.lockedUntil - now) : 0
}

export function recordWrongPin(a: PinAttempts, now: number, online: boolean): PinAttempts {
  const failures = a.failures + 1
  if (failures < MAX_WRONG_PINS) return { ...a, failures }
  if (online) return { ...a, failures: 0, requirePassword: true }
  const rounds = a.rounds + 1
  const delay = OFFLINE_DELAYS_MS[Math.min(rounds, OFFLINE_DELAYS_MS.length) - 1]!
  return { ...a, failures: 0, rounds, lockedUntil: now + delay }
}
