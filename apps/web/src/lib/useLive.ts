import { liveQuery } from 'dexie'
import { useEffect, useState } from 'react'

/** Re-runs a Dexie query whenever the tables it read change. `value` is undefined until the first
 * result, so the first render can show a skeleton instead of an empty state. */
export function useLive<T>(query: () => Promise<T>, deps: readonly unknown[]): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined)
  useEffect(() => {
    const subscription = liveQuery(query).subscribe({
      next: setValue,
      error: () => undefined, // a failed read leaves the last value on screen
    })
    return () => subscription.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `query` is described by `deps`
  }, deps)
  return value
}
