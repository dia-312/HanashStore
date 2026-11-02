import type { Table } from 'dexie'
import {
  db,
  getMeta,
  setMeta,
  type DbCategory,
  type DbCustomer,
  type DbImage,
  type DbInvoice,
  type DbInvoiceLine,
  type DbPayment,
  type DbProduct,
  type DbReturn,
  type DbReturnLine,
  type DbSynonymGroup,
  type DbVariant,
} from '../../db'
import { api } from '../api'

export interface PullPage {
  changes: {
    categories: DbCategory[]
    /** Absent from an older server. */
    synonym_groups?: DbSynonymGroup[]
    products: DbProduct[]
    variants: DbVariant[]
    images: DbImage[]
    customers: DbCustomer[]
    invoices: DbInvoice[]
    invoice_lines: DbInvoiceLine[]
    payments: DbPayment[]
    /** Absent from an older server. */
    returns?: DbReturn[]
    return_lines?: DbReturnLine[]
  }
  cursor: number
  has_more: boolean
  /** Changes when the server is restored from a backup; absent from an older server. */
  epoch?: string
  /** Business settings: a few values, sent with every page. */
  settings?: Record<string, unknown>
}

export const CURSOR_KEY = 'syncCursor'

/** Rows written per IndexedDB transaction. One huge transaction would hold every other read and
 * write (the PIN record, the outbox) until it finished, so a big page goes in as several. */
export const CHUNK = 250

/**
 * Applies one page. The rows go in in chunks, each its own transaction, and the cursor moves last,
 * so a page cut short (the app closed half-way) is simply fetched and applied again: writing a row
 * twice changes nothing. A row made on this device and not yet confirmed has `change_seq` 0, so
 * the server's version always replaces it.
 */
export async function applyPage(page: PullPage): Promise<void> {
  const c = page.changes
  const write = async <T extends { id: string; change_seq: number }>(
    rows: T[] | undefined,
    table: Table<T, string>,
  ) => {
    if (!rows) return
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK)
      await db.transaction('rw', table, async () => {
        const existing = await table.bulkGet(chunk.map((r) => r.id))
        await table.bulkPut(
          chunk.filter((row, j) => !existing[j] || existing[j].change_seq <= row.change_seq),
        )
      })
    }
  }
  await write(c.categories, db.categories as unknown as Table<DbCategory, string>)
  await write(c.synonym_groups, db.synonym_groups as unknown as Table<DbSynonymGroup, string>)
  await write(c.products, db.products as unknown as Table<DbProduct, string>)
  await write(c.variants, db.variants as unknown as Table<DbVariant, string>)
  await write(c.images, db.images as unknown as Table<DbImage, string>)
  await write(c.customers, db.customers as unknown as Table<DbCustomer, string>)
  await write(c.invoices, db.invoices as unknown as Table<DbInvoice, string>)
  await write(c.invoice_lines, db.invoice_lines as unknown as Table<DbInvoiceLine, string>)
  await write(c.payments, db.payments as unknown as Table<DbPayment, string>)
  await write(c.returns, db.returns as unknown as Table<DbReturn, string>)
  await write(c.return_lines, db.return_lines as unknown as Table<DbReturnLine, string>)
  if (page.settings) {
    const rows = Object.entries(page.settings).map(([key, value]) => ({ key, value }))
    await db.settings.bulkPut(rows)
  }
  await setMeta(CURSOR_KEY, page.cursor)
}

export const pullPage = (cursor: number) => api<PullPage>(`/sync/pull?cursor=${cursor}`)

const rowCount = (page: PullPage) =>
  Object.values(page.changes).reduce((sum, rows) => sum + (rows?.length ?? 0), 0)

export const EPOCH_KEY = 'syncEpoch'

/** Every table the server fills. Rows made on this device and not yet confirmed have `change_seq` 0
 * and are not touched: they are the rep's work, and the command that carries them is still waiting. */
const SERVER_TABLES = [
  'categories',
  'synonym_groups',
  'products',
  'variants',
  'images',
  'customers',
  'invoices',
  'invoice_lines',
  'payments',
  'returns',
  'return_lines',
] as const

/**
 * The server was restored from a backup (its epoch changed): what this device read from it may be
 * rows that no longer exist, and its cursor may be ahead of the new numbers. Forget what came from
 * the server, keep what is waiting to be sent, and read everything again.
 */
export async function forgetServerData(): Promise<void> {
  await db.transaction('rw', [...SERVER_TABLES.map((name) => db[name]), db.meta], async () => {
    for (const name of SERVER_TABLES) {
      await (db[name] as unknown as Table<{ change_seq: number }, string>)
        .filter((row) => row.change_seq > 0)
        .delete()
    }
    await db.meta.delete(CURSOR_KEY)
  })
}

/** Pulls until the server has nothing newer. Returns how many rows came in. */
export async function pullAll(fetchPage: (cursor: number) => Promise<PullPage> = pullPage) {
  let cursor = (await getMeta<number>(CURSOR_KEY)) ?? 0
  let rows = 0
  let known = await getMeta<string>(EPOCH_KEY)
  for (;;) {
    const page = await fetchPage(cursor)
    if (page.epoch) {
      if (known === undefined) {
        // First time this device sees the server's epoch; nothing to compare with yet.
        await setMeta(EPOCH_KEY, page.epoch)
        known = page.epoch
      } else if (known !== page.epoch) {
        await forgetServerData()
        await setMeta(EPOCH_KEY, page.epoch)
        known = page.epoch
        cursor = 0
        continue // ask again from the start: this page was answered for the old cursor
      }
    }
    await applyPage(page)
    rows += rowCount(page)
    // A page that changes nothing must not loop forever.
    if (!page.has_more || page.cursor <= cursor) break
    cursor = page.cursor
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the screen breathe between pages
  }
  return rows
}
