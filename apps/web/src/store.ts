import { create } from 'zustand'
import { getMeta, removeMeta, setMeta, wipeLocalData } from './db'
import { ApiError, api, getClockSkewMs } from './lib/api'
import { type PinAttempts, freshAttempts, recordWrongPin, remainingLockMs } from './lib/lock'
import { type PinRecord, createPinRecord, verifyPin } from './lib/pin'
import { setSyncHooks } from './lib/sync/engine'
import { pendingCount } from './lib/sync/outbox'

export type Status = 'booting' | 'loggedOut' | 'needsPin' | 'locked' | 'unlocked'
export type UnlockResult = 'ok' | 'wrong' | 'locked' | 'password'

interface Identity {
  user: { id: string; name: string }
  device: { id: string; name: string }
}

interface Me extends Identity {
  has_pin: boolean
}

interface AuthState {
  status: Status
  identity: Identity | null
  pinLength: number
  attempts: PinAttempts
  /** The server said the session is gone. The device keeps working; the rep logs in again when online. */
  sessionExpired: boolean
  clockOff: boolean
  boot: () => Promise<void>
  login: (password: string, confirmReplace?: boolean) => Promise<void>
  savePin: (pin: string) => Promise<void>
  unlock: (pin: string) => Promise<UnlockResult>
  unlockWithPassword: (password: string) => Promise<void>
  lock: () => void
  logout: () => Promise<void>
  logoutAll: () => Promise<void>
  /** The server revoked this device: wipe everything and go back to the login screen. */
  deviceRevoked: () => Promise<void>
}

const CLOCK_SKEW_LIMIT_MS = 5 * 60_000
const KEYS = { identity: 'identity', pin: 'pin', attempts: 'attempts' } as const

/** Raised by logout while commands wait in the outbox: leaving now would throw them away. */
export const PENDING_COMMANDS = 'PENDING_COMMANDS'

export const deviceName = () => (/iPad|Macintosh/.test(navigator.userAgent) ? 'iPad' : 'Browser')

/** Ask the browser not to evict our data; Safari may refuse and that is only informational (SPEC section 8). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

const initial = {
  status: 'booting' as Status,
  identity: null,
  pinLength: 0,
  attempts: freshAttempts(),
  sessionExpired: false,
  clockOff: false,
}

export const useAuth = create<AuthState>()((set, get) => {
  const saveAttempts = async (attempts: PinAttempts) => {
    set({ attempts })
    await setMeta(KEYS.attempts, attempts)
  }

  const reset = () => set({ ...initial, status: 'loggedOut' })

  /** Checks the session in the background after start; never blocks the lock screen. */
  const verifySession = async () => {
    try {
      await api<Me>('/auth/me')
      set({
        sessionExpired: false,
        clockOff: Math.abs(getClockSkewMs() ?? 0) > CLOCK_SKEW_LIMIT_MS,
      })
    } catch (e) {
      if (!(e instanceof ApiError)) return
      if (e.code === 'DEVICE_REVOKED') {
        await get().deviceRevoked()
      } else if (e.code === 'UNAUTHENTICATED') {
        set({ sessionExpired: true }) // never wipes: the outbox must survive an expired session
      }
    }
  }

  return {
    ...initial,

    boot: async () => {
      const identity = await getMeta<Identity>(KEYS.identity)
      if (!identity) return set({ status: 'loggedOut' })
      const pin = await getMeta<PinRecord>(KEYS.pin)
      const attempts = (await getMeta<PinAttempts>(KEYS.attempts)) ?? freshAttempts()
      set({
        identity,
        attempts,
        pinLength: pin?.length ?? 0,
        status: pin ? 'locked' : 'needsPin',
      })
      if (navigator.onLine) void verifySession()
    },

    login: async (password, confirmReplace = false) => {
      const known = await getMeta<Identity>(KEYS.identity)
      const me = await api<Me>('/auth/login', {
        method: 'POST',
        body: {
          password,
          device_name: deviceName(),
          device_id: known?.device.id,
          confirm_replace: confirmReplace,
        },
      })
      const identity = { user: me.user, device: me.device }
      await setMeta(KEYS.identity, identity)
      void requestPersistence()
      // A local PIN is kept only for the same user; anyone else starts clean.
      const sameUser = known?.user.id === identity.user.id
      if (known && !sameUser) await removeMeta(KEYS.pin)
      const pin = sameUser ? await getMeta<PinRecord>(KEYS.pin) : undefined
      await saveAttempts(freshAttempts())
      set({
        identity,
        sessionExpired: false,
        pinLength: pin?.length ?? 0,
        status: pin ? 'unlocked' : 'needsPin',
      })
    },

    savePin: async (pin) => {
      await api('/auth/pin', { method: 'PUT', body: { pin } })
      const record = await createPinRecord(pin)
      await setMeta(KEYS.pin, record)
      await saveAttempts(freshAttempts())
      set({ pinLength: record.length, status: 'unlocked' })
    },

    unlock: async (pin) => {
      const { attempts } = get()
      const now = Date.now()
      if (attempts.requirePassword) return 'password'
      if (remainingLockMs(attempts, now) > 0) return 'locked'
      const record = await getMeta<PinRecord>(KEYS.pin)
      if (record && (await verifyPin(record, pin))) {
        await saveAttempts(freshAttempts())
        set({ status: 'unlocked' })
        return 'ok'
      }
      const next = recordWrongPin(attempts, now, navigator.onLine)
      await saveAttempts(next)
      if (next.requirePassword) return 'password'
      return remainingLockMs(next, now) > 0 ? 'locked' : 'wrong'
    },

    // After too many wrong PINs online the full password unlocks (SPEC section 13); login resets the attempts.
    unlockWithPassword: (password) => get().login(password),

    lock: () => {
      if (get().status === 'unlocked') set({ status: 'locked' })
    },

    logout: async () => {
      // Refuse while the outbox has pending commands: the wipe below would lose them (SPEC F1).
      if ((await pendingCount()) > 0) throw new Error(PENDING_COMMANDS)
      await api('/auth/logout', { method: 'POST' })
      await wipeLocalData()
      reset()
    },

    logoutAll: async () => {
      if ((await pendingCount()) > 0) throw new Error(PENDING_COMMANDS)
      await api('/auth/logout-all', { method: 'POST' })
      await wipeLocalData()
      reset()
    },

    deviceRevoked: async () => {
      await wipeLocalData()
      reset()
    },
  }
})

setSyncHooks({
  onSessionExpired: () => useAuth.setState({ sessionExpired: true }),
  onDeviceRevoked: () => void useAuth.getState().deviceRevoked(),
})

/** Test helper: forget in-memory state without touching IndexedDB. */
export const resetAuthStore = () => useAuth.setState({ ...initial })
