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

/** Rows older than what we already hold are skipped: a push result may be newer than a page. */
async function putNewer<T extends { id: string; change_seq: number }>(
  rows: T[],
  get: (ids: string[]) => Promise<(T | undefined)[]>,
  put: (rows: T[]) => Promise<unknown>,
): Promise<void> {
  if (rows.length === 0) return
  const existing = await get(rows.map((r) => r.id))
  await put(rows.filter((row, i) => !existing[i] || existing[i].change_seq <= row.change_seq))
}

/** Applies one page and moves the cursor, all in a single transaction. */
export async function applyPage(page: PullPage): Promise<void> {
  const { categories, products, variants, images } = page.changes
  await db.transaction(
    'rw',
    [db.categories, db.products, db.variants, db.images, db.meta],
    async () => {
      await putNewer(
        categories,
        (ids) => db.categories.bulkGet(ids),
        (rows) => db.categories.bulkPut(rows),
      )
      await putNewer(
        products,
        (ids) => db.products.bulkGet(ids),
        (rows) => db.products.bulkPut(rows),
      )
      await putNewer(
        variants,
        (ids) => db.variants.bulkGet(ids),
        (rows) => db.variants.bulkPut(rows),
      )
      await putNewer(
        images,
        (ids) => db.images.bulkGet(ids),
        (rows) => db.images.bulkPut(rows),
      )
      await setMeta(CURSOR_KEY, page.cursor)
    },
  )
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
