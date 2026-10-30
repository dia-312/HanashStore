import type { Table } from 'dexie'
import {
  db,
  getMeta,
  setMeta,
  type DbCategory,
  type DbImage,
  type DbProduct,
  type DbVariant,
} from '../../db'
import { api } from '../api'

export interface PullPage {
  changes: {
    categories: DbCategory[]
    products: DbProduct[]
    variants: DbVariant[]
    images: DbImage[]
  }
  cursor: number
  has_more: boolean
}

export const CURSOR_KEY = 'syncCursor'

/** Rows written per IndexedDB transaction. One huge transaction would hold every other read and
 * write (the PIN record, the outbox) until it finished, so a big page goes in as several. */
export const CHUNK = 250

/**
 * Applies one page. The rows go in in chunks, each its own transaction, and the cursor moves last,
 * so a page cut short (the app closed half-way) is simply fetched and applied again: writing a row
 * twice changes nothing.
 */
export async function applyPage(page: PullPage): Promise<void> {
  const { categories, products, variants, images } = page.changes
  const write = async <T extends { id: string; change_seq: number }>(
    rows: T[],
    table: Table<T, string>,
  ) => {
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
  await write(categories, db.categories as unknown as Table<DbCategory, string>)
  await write(products, db.products as unknown as Table<DbProduct, string>)
  await write(variants, db.variants as unknown as Table<DbVariant, string>)
  await write(images, db.images as unknown as Table<DbImage, string>)
  await setMeta(CURSOR_KEY, page.cursor)
}

export const pullPage = (cursor: number) => api<PullPage>(`/sync/pull?cursor=${cursor}`)

const rowCount = (page: PullPage) =>
  page.changes.categories.length +
  page.changes.products.length +
  page.changes.variants.length +
  page.changes.images.length

/** Pulls until the server has nothing newer. Returns how many rows came in. */
export async function pullAll(fetchPage: (cursor: number) => Promise<PullPage> = pullPage) {
  let cursor = (await getMeta<number>(CURSOR_KEY)) ?? 0
  let rows = 0
  for (;;) {
    const page = await fetchPage(cursor)
    await applyPage(page)
    rows += rowCount(page)
    // A page that changes nothing must not loop forever.
    if (!page.has_more || page.cursor <= cursor) break
    cursor = page.cursor
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the screen breathe between pages
  }
  return rows
}
