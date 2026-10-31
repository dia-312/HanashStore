import { useEffect } from 'react'
import { syncNow } from './engine'

/** Asks for a sync when a screen that shows stock opens, so what changed on the server since the
 * last minute is there as soon as the rep looks. A pull with nothing new takes a few dozen ms. */
export function useSyncOnOpen(): void {
  useEffect(() => {
    void syncNow()
  }, [])
}
