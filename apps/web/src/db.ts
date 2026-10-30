import Dexie, { type EntityTable } from 'dexie'

interface MetaRow {
  key: string
  value: unknown
}

// Rows pulled from the server (apps/api/app/schemas.py, Sync*). Money is integer agorot.
export interface DbCategory {
  id: string
  name: string
  sort_order: number
  is_active: boolean
  change_seq: number
}

export interface DbProduct {
  id: string
  category_id: string
  name: string
  description: string | null
  search_text: string
  is_active: boolean
  change_seq: number
}

export interface DbVariant {
  id: string
  product_id: string
  sku: string
  color: string | null
  size: string | null
  price: number
  min_stock: number
  /** What the server last said. The stock shown on screen also counts the commands still waiting. */
  stock_qty: number
  is_active: boolean
  change_seq: number
}

export interface DbImage {
  id: string
  product_id: string
  variant_id: string | null
  thumb_url: string
  full_url: string
  sort_order: number
  deleted_at: string | null
  change_seq: number
}

export interface CommandError {
  code: string
  message: string
  details: Record<string, unknown>
}

/** A command waiting to be sent (SPEC section 8). `seq` keeps the order they were made in. */
export interface OutboxRow {
  seq?: number
  id: string
  type: string
  schema_version: number
  payload: unknown
  created_at: string
  /** `rejected` stays here, on the sync screen, until the rep discards or retries it. */
  status: 'pending' | 'rejected'
  error?: CommandError
}

export type SalesDb = Dexie & {
  meta: EntityTable<MetaRow, 'key'>
  categories: EntityTable<DbCategory, 'id'>
  products: EntityTable<DbProduct, 'id'>
  variants: EntityTable<DbVariant, 'id'>
  images: EntityTable<DbImage, 'id'>
  outbox: EntityTable<OutboxRow, 'seq'>
}

export const db = new Dexie('sales-rep') as SalesDb
// Version 1 (M1) only had `meta`. Version 2 adds the working copy and the outbox; nothing in `meta`
// is touched, so the login identity, PIN record and counters survive the upgrade.
db.version(1).stores({ meta: 'key' })
db.version(2).stores({
  meta: 'key',
  categories: 'id',
  products: 'id, category_id',
  variants: 'id, product_id',
  images: 'id, product_id',
  outbox: '++seq, &id, status',
})

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
  await db.transaction('rw', db.tables, () => Promise.all(db.tables.map((table) => table.clear())))
  if ('caches' in globalThis) {
    for (const name of await caches.keys()) await caches.delete(name)
  }
}
