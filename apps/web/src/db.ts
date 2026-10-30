import Dexie, { type EntityTable } from 'dexie'

interface MetaRow {
  key: string
  value: unknown
}

/** M1 only needs key/value rows (who is logged in, the PIN record, lock attempts).
 * The real schema (catalog, customers, outbox...) arrives with M3 as a versioned migration. */
export const db = new Dexie('sales-rep') as Dexie & { meta: EntityTable<MetaRow, 'key'> }
db.version(1).stores({ meta: 'key' })

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value })
}

export async function removeMeta(key: string): Promise<void> {
  await db.meta.delete(key)
}

/** Logout / revoked device: forget everything stored here and every service-worker cache (SPEC F1). */
export async function wipeLocalData(): Promise<void> {
  await db.meta.clear()
  if ('caches' in globalThis) {
    for (const name of await caches.keys()) await caches.delete(name)
  }
}
