import { db, getMeta, setMeta } from '../db'
import { api } from './api'

// Document numbers are made on the device, so they work offline: INV-000042 for invoices and
// REC-000010 for payments (SPEC section 7). A counter per kind lives in `meta`. A device starts
// above the highest number the server has, which matters on a replacement iPad.

export type DocKind = 'INV' | 'REC'
type Counters = Record<DocKind, number>

const KEY = 'counters'
const EMPTY: Counters = { INV: 0, REC: 0 }

export const formatNumber = (kind: DocKind, n: number) => `${kind}-${String(n).padStart(6, '0')}`

const read = async (): Promise<Counters> => ({
  ...EMPTY,
  ...(await getMeta<Partial<Counters>>(KEY)),
})

/** The next number of this kind. Call it inside the transaction that saves the document, so a
 * number is only used up if the document is. */
export async function takeNumber(kind: DocKind): Promise<string> {
  const counters = await read()
  counters[kind] += 1
  await setMeta(KEY, counters)
  return formatNumber(kind, counters[kind])
}

/** Moves the counters up to what the server has seen; they never go down. */
export async function raiseCounters(server: Partial<Counters>): Promise<void> {
  await db.transaction('rw', db.meta, async () => {
    const counters = await read()
    for (const kind of ['INV', 'REC'] as const) {
      counters[kind] = Math.max(counters[kind], server[kind] ?? 0)
    }
    await setMeta(KEY, counters)
  })
}

export const fetchServerNumbers = () => api<Counters>('/sync/numbers')
