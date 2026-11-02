import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, wipeLocalData } from '../db'
import { recordPayment, recordRefund, saveCustomer } from './sales'
import { pendingCommands } from './sync/outbox'

// QA of the offline engine on the device: many writes at the same moment must never share a document
// number, lose a command, or leave a half-written document.

beforeEach(async () => {
  await wipeLocalData()
})

describe('writes at the same moment', () => {
  it('twenty payments and ten refunds started together get thirty different, gap-free numbers', async () => {
    const customerId = await saveCustomer({ name: 'محل' })
    const jobs = [
      ...Array.from({ length: 20 }, () =>
        recordPayment({ customerId, amount: 100, method: 'cash' }),
      ),
      ...Array.from({ length: 10 }, () => recordRefund({ customerId, amount: 50, method: 'cash' })),
    ]
    const results = await Promise.all(jobs)
    const numbers = results.map((r) => r.number)
    expect(new Set(numbers).size).toBe(30)
    const rec = numbers.filter((n) => n.startsWith('REC-')).sort()
    const ref = numbers.filter((n) => n.startsWith('REF-')).sort()
    expect(rec).toEqual(
      Array.from({ length: 20 }, (_, i) => `REC-${String(i + 1).padStart(6, '0')}`),
    )
    expect(ref).toEqual(
      Array.from({ length: 10 }, (_, i) => `REF-${String(i + 1).padStart(6, '0')}`),
    )
    // every document has its command, and every command its document
    const commands = await pendingCommands()
    expect(commands.filter((c) => c.type === 'payment.create')).toHaveLength(20)
    expect(commands.filter((c) => c.type === 'refund.create')).toHaveLength(10)
    expect(await db.payments.count()).toBe(30)
  })

  it('a payment that fails leaves no number used and no command behind', async () => {
    const customerId = await saveCustomer({ name: 'محل' })
    await expect(recordPayment({ customerId, amount: 0, method: 'cash' })).rejects.toThrow()
    await expect(
      recordPayment({ customerId: 'nobody', amount: 100, method: 'cash' }),
    ).rejects.toThrow()
    expect((await pendingCommands()).filter((c) => c.type === 'payment.create')).toHaveLength(0)
    const first = await recordPayment({ customerId, amount: 100, method: 'cash' })
    expect(first.number).toBe('REC-000001') // the failed ones did not use up a number
  })
})

describe('upgrading the stored data', () => {
  it('a device that had the version-5 database keeps everything when the app opens it as version 6', async () => {
    await db.delete()
    // The database as the M7 app left it, with what a working device would have in it.
    const old = new Dexie('sales-rep')
    old.version(5).stores({
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
    await old.open()
    await old.table('meta').put({ key: 'counters', value: { INV: 41, REC: 9, RET: 2, REF: 1 } })
    await old.table('meta').put({ key: 'syncCursor', value: 77 })
    await old.table('outbox').add({
      id: 'cmd-1',
      type: 'payment.create',
      schema_version: 1,
      payload: { amount: 500 },
      created_at: '2026-11-02T10:00:00Z',
      status: 'pending',
    })
    await old.table('products').put({ id: 'p1', name: 'منتج', category_id: 'c1' })
    old.close()

    await db.open() // the app's own definition: version 6 adds the synonym groups
    expect(db.verno).toBe(6)
    expect((await db.meta.get('counters'))?.value).toEqual({ INV: 41, REC: 9, RET: 2, REF: 1 })
    expect((await db.meta.get('syncCursor'))?.value).toBe(77)
    expect((await pendingCommands()).map((c) => c.id)).toEqual(['cmd-1'])
    expect(await db.products.count()).toBe(1)
    expect(await db.synonym_groups.count()).toBe(0)
    await db.synonym_groups.put({ id: 'g', terms: ['a', 'b'], is_active: true, change_seq: 1 })
    expect(await db.synonym_groups.count()).toBe(1)
  })
})
