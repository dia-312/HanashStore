import { useEffect } from 'react'
import { backgroundExpired, idleExpired } from './lib/lock'
import { useAuth } from './store'

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const

/** Locks the app after 5 minutes without touches and after 5 minutes in the background (SPEC F1). */
export function useAutoLock(): void {
  const status = useAuth((s) => s.status)
  const lock = useAuth((s) => s.lock)

  useEffect(() => {
    if (status !== 'unlocked') return
    let lastActive = Date.now()
    let hiddenAt: number | null = null

    const touch = () => (lastActive = Date.now())
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      if (hiddenAt !== null && backgroundExpired(hiddenAt, Date.now())) lock()
      hiddenAt = null
      touch()
    }
    const timer = setInterval(() => {
      if (idleExpired(lastActive, Date.now())) lock()
    }, 15_000)

    for (const e of ACTIVITY_EVENTS)
      window.addEventListener(e, touch, { passive: true, capture: true })
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, touch, { capture: true })
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [status, lock])
}
