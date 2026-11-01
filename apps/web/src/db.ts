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

export interface DbCustomer {
  id: string
  name: string
  shop_name: string | null
  phone: string | null
  area: string | null
  address: string | null
  notes: string | null
  opening_balance: number
  search_text: string
  is_active: boolean
  /** What the server last said he owes (positive) or is owed (negative); the screen adds the
   * effect of the commands still waiting. */
  balance: number
  /** 0 for a row made on this device and not yet confirmed by the server. */
  change_seq: number
}

export interface DbInvoice {
  id: string
  number: string
  customer_id: string
  status: 'confirmed' | 'cancelled'
  subtotal: number
  discount: number
  total: number
  note: string | null
  issued_at: string
  delivered_at: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  change_seq: number
}

export interface DbInvoiceLine {
  id: string
  invoice_id: string
  variant_id: string
  product_name: string
  variant_label: string
  qty: number
  unit_price: number
  line_total: number
  discount_share: number
  sort_order: number
  change_seq: number
}

export interface DbPayment {
  id: string
  number: string
  customer_id: string
  invoice_id: string | null
  method: 'cash' | 'transfer' | 'cheque'
  amount: number
  paid_at: string
  note: string | null
  status: 'active' | 'voided'
  voided_at: string | null
  void_reason: string | null
  change_seq: number
}

export interface DbReturn {
  id: string
  number: string
  customer_id: string
  invoice_id: string
  reason: string | null
  total: number
  issued_at: string
  change_seq: number
}

export interface DbReturnLine {
  id: string
  return_id: string
  invoice_line_id: string
  qty: number
  disposition: 'restock' | 'damaged'
  amount: number
  change_seq: number
}

/** A draft sale: one open cart per customer, and one for a sale with no customer yet (`id` is
 * the customer id, or `none`). Lives only on this device. */
export interface DbCart {
  id: string
  customer_id: string | null
  lines: { variant_id: string; qty: number }[]
  updated_at: string
}

/** A business setting from the server (name, phone, footer, logo, presentation switch). */
export interface DbSetting {
  key: string
  value: unknown
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
  customers: EntityTable<DbCustomer, 'id'>
  invoices: EntityTable<DbInvoice, 'id'>
  invoice_lines: EntityTable<DbInvoiceLine, 'id'>
  payments: EntityTable<DbPayment, 'id'>
  returns: EntityTable<DbReturn, 'id'>
  return_lines: EntityTable<DbReturnLine, 'id'>
  carts: EntityTable<DbCart, 'id'>
  settings: EntityTable<DbSetting, 'key'>
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
// Version 3 (M4): customers, invoices and payments from the server, and local carts. The outbox,
// the carts of an older version (none) and `meta` (login, PIN, counters) are left as they are.
db.version(3).stores({
  meta: 'key',
  categories: 'id',
  products: 'id, category_id',
  variants: 'id, product_id',
  images: 'id, product_id',
  outbox: '++seq, &id, status',
  customers: 'id',
  invoices: 'id, customer_id, status, issued_at',
  invoice_lines: 'id, invoice_id',
  payments: 'id, customer_id, invoice_id',
  carts: 'id',
})

// Version 4 (M5): the business settings, kept so the offline PNG has the name, phone and footer.
db.version(4).stores({
  meta: 'key',
  categories: 'id',
  products: 'id, category_id',
  variants: 'id, product_id',
  images: 'id, product_id',
  outbox: '++seq, &id, status',
  customers: 'id',
  invoices: 'id, customer_id, status, issued_at',
  invoice_lines: 'id, invoice_id',
  payments: 'id, customer_id, invoice_id',
  carts: 'id',
  settings: 'key',
})

// Version 5 (M7): returns and their lines. Nothing already stored is touched.
db.version(5).stores({
  meta: 'key',
  categories: 'id',
  products: 'id, category_id',
  variants: 'id, product_id',
  images: 'id, product_id',
  outbox: '++seq, &id, status',
  customers: 'id',
  invoices: 'id, customer_id, status, issued_at',
  invoice_lines: 'id, invoice_id',
  payments: 'id, customer_id, invoice_id',
  returns: 'id, customer_id, invoice_id',
  return_lines: 'id, return_id, invoice_line_id',
  carts: 'id',
  settings: 'key',
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
