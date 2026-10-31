import { getMeta, setMeta } from '../db'

/** Timings measured on this device, kept so Settings can show them: the rep (and whoever tests the
 * app on the iPad) reads real numbers instead of guessing against the budgets in SPEC section 17. */
export interface PerfNumbers {
  /** From opening the catalog screen to its products on screen. */
  catalogOpenMs?: number
  /** Duration of the very first sync on this device. */
  firstSyncMs?: number
}

export const PERF_KEY = 'perf'

export async function recordPerf(partial: PerfNumbers): Promise<void> {
  try {
    await setMeta(PERF_KEY, { ...(await getMeta<PerfNumbers>(PERF_KEY)), ...partial })
  } catch {
    // numbers for the curious: never worth a failure
  }
}

export const readPerf = () => getMeta<PerfNumbers>(PERF_KEY)
