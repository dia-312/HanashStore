import { beforeEach, describe, expect, it } from 'vitest'
import { db, getMeta, setMeta, wipeLocalData, type DbCustomer, type DbVariant } from '../../db'
import { CURSOR_KEY, EPOCH_KEY, pullAll, type PullPage } from './pull'

// The server was restored from a backup: its epoch changes, and a device that sees it forgets what
// it had read from the server and reads everything again, keeping the work that is waiting to go.

const variant = (id: string, change_seq: number, stock_qty = 10): DbVariant => ({
  id,
  product_id: 'p',
  sku: id,
  color: null,
  size: null,
  price: 1000,
  min_stock: 1,
  stock_qty,
  is_active: true,
  change_seq,
})

const customer = (id: string, change_seq: number, name = id): DbCustomer => ({
  id,
  name,
  shop_name: null,
  phone: null,
  area: null,
  address: null,
  notes: null,
  opening_balance: 0,
  search_text: name,
  is_active: true,
  balance: 0,
  change_seq,
})

const empty = (): PullPage['changes'] => ({
  categories: [],
  products: [],
  variants: [],
  images: [],
  customers: [],
  invoices: [],
  invoice_lines: [],
  payments: [],
})

/** A server that answers from `rows` for any cursor, with the given epoch. */
const server =
  (epoch: string | undefined, rows: Partial<PullPage['changes']>, last: number) =>
  async (cursor: number): Promise<PullPage> => ({
    changes: cursor < last ? { ...empty(), ...rows } : empty(),
    cursor: Math.max(cursor, last),
    has_more: false,
    epoch,
  })

beforeEach(async () => {
  await wipeLocalData()
})

describe('the server epoch', () => {
  it('the first epoch is simply remembered; nothing is dropped', async () => {
    await db.variants.put(variant('old', 5))
    await pullAll(server('A', { variants: [variant('a', 7)] }, 7))
    expect(await getMeta(EPOCH_KEY)).toBe('A')
    expect((await db.variants.toArray()).map((v) => v.id).sort()).toEqual(['a', 'old'])
  })

  it('the same epoch changes nothing', async () => {
    await pullAll(server('A', { variants: [variant('a', 7)] }, 7))
    await pullAll(server('A', { variants: [variant('a', 7), variant('b', 8)] }, 8))
    expect((await db.variants.toArray()).map((v) => v.id).sort()).toEqual(['a', 'b'])
    expect(await getMeta(CURSOR_KEY)).toBe(8)
  })

  it('a new epoch drops what came from the old server and reads everything again', async () => {
    // before: the device had read rows 1..50 from the old server, which later lost 40..50
    await pullAll(
      server(
        'A',
        {
          variants: [variant('kept', 10), variant('lost', 48)],
          customers: [customer('ghost', 49)],
        },
        50,
      ),
    )
    expect(await getMeta(CURSOR_KEY)).toBe(50)
    // the restored server only has `kept`, at a lower number, and a customer made after the restore
    const restored = server(
      'B',
      { variants: [variant('kept', 10, 7)], customers: [customer('new', 12)] },
      12,
    )
    const rows = await pullAll(restored)
    expect(rows).toBe(2)
    expect((await db.variants.toArray()).map((v) => [v.id, v.stock_qty])).toEqual([['kept', 7]])
    expect((await db.customers.toArray()).map((c) => c.id)).toEqual(['new'])
    expect(await getMeta(CURSOR_KEY)).toBe(12)
    expect(await getMeta(EPOCH_KEY)).toBe('B')
  })

  it('work waiting to be sent survives: rows with change_seq 0 and the outbox', async () => {
    await pullAll(server('A', { customers: [customer('synced', 30)] }, 30))
    await db.customers.put(customer('mine', 0, 'زبون جديد')) // made on this device, not sent yet
    await db.outbox.add({
      id: 'cmd',
      type: 'customer.upsert',
      schema_version: 1,
      payload: { customer_id: 'mine' },
      created_at: '2026-11-02T10:00:00Z',
      status: 'pending',
    })
    await setMeta('counters', { INV: 5, REC: 2, RET: 0, REF: 0 })

    await pullAll(server('B', { customers: [customer('other', 3)] }, 3))

    expect((await db.customers.toArray()).map((c) => c.id).sort()).toEqual(['mine', 'other'])
    expect(await db.outbox.count()).toBe(1)
    expect((await getMeta<Record<string, number>>('counters'))?.INV).toBe(5)
  })

  it('a server that sends no epoch (an older one) never triggers it', async () => {
    await pullAll(server('A', { variants: [variant('a', 7)] }, 7))
    await pullAll(server(undefined, {}, 9))
    expect(await db.variants.count()).toBe(1)
    expect(await getMeta(EPOCH_KEY)).toBe('A')
  })

  it('does not loop: after resetting once it goes on with the page it asked for', async () => {
    await pullAll(server('A', { variants: [variant('a', 7)] }, 7))
    let calls = 0
    const counting = server('B', { variants: [variant('b', 2)] }, 2)
    await pullAll(async (cursor) => {
      calls += 1
      expect(calls).toBeLessThan(10)
      return counting(cursor)
    })
    expect(calls).toBeLessThanOrEqual(3)
    expect((await db.variants.toArray()).map((v) => v.id)).toEqual(['b'])
  })
})
