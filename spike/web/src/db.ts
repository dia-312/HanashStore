import Dexie, { liveQuery, type EntityTable } from 'dexie'
import { useEffect, useState } from 'react'

export interface Note { id: string; text: string; createdAt: number }
export interface Variant {
  id: number
  productId: number
  name: string
  color: string
  size: string
  sku: string
  price: number // agorot
  stock: number
  thumb: string
}
export interface Launch { id?: number; at: number; standalone: boolean; online: boolean }
export interface Result { id: string; status: 'pass' | 'fail' | null; note: string; at: number }

export const db = new Dexie('spike-m0') as Dexie & {
  notes: EntityTable<Note, 'id'>
  variants: EntityTable<Variant, 'id'>
  launches: EntityTable<Launch, 'id'>
  results: EntityTable<Result, 'id'>
}

db.version(1).stores({
  notes: 'id, createdAt',
  variants: 'id, productId',
  launches: '++id, at',
  results: 'id',
})

/** Minimal live query hook (avoids adding dexie-react-hooks, which is not in the SPEC stack). */
export function useLive<T>(query: () => Promise<T>, initial: T, deps: unknown[] = []): T {
  const [value, setValue] = useState<T>(initial)
  useEffect(() => {
    const sub = liveQuery(query).subscribe({ next: setValue, error: (e) => console.error(e) })
    return () => sub.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return value
}

export async function saveResult(id: string, patch: Partial<Omit<Result, 'id'>>) {
  const prev = await db.results.get(id)
  await db.results.put({ id, status: null, note: '', ...prev, ...patch, at: Date.now() })
}
