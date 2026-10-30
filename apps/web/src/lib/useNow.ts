import { useEffect, useState } from 'react'

/** The current time, refreshed every `everyMs`, so render code never calls `Date.now()` itself. */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}
