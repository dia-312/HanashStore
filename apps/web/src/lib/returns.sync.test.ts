import { beforeEach, describe, expect, it } from 'vitest'
import { db, setMeta, wipeLocalData } from '../db'
import { returnLineAmount } from './billing'
import { statementDocument } from './documents'
import { buildInvoiceDetail, buildReturnList, loadSalesSnapshot } from './localSales'
import { DEFAULT_SETTINGS } from './settings'
import { cancelInvoice, confirmSale, createReturn } from './sales'
import { effectiveBalance } from './sync/effectiveBalance'
import { effectiveStock } from './sync/effectiveStock'
import type { ReturnCreatePayload } from './sync/commands'
import { discard, markRejected, pendingCommands, retry } from './sync/outbox'

beforeEach(async () => {
  await wipeLocalData()
  await setMeta('identity', { user: { id: 'u', name: 'Rep' }, device: { id: 'd1', name: 'iPad' } })
  await db.products.put({
    id: 'p1',
    category_id: 'cat',
    name: 'أرجيلة',
    description: null,
    search_text: 'ارجيله',
    is_active: true,
    change_seq: 1,
  })
  await db.variants.bulkPut([
    {
      id: 'v1',
      product_id: 'p1',
      sku: 'S1',
      color: null,
      size: null,
      price: 1000,
      min_stock: 0,
      stock_qty: 50,
      is_active: true,
      change_seq: 1,
    },
    {
      id: 'v2',
      product_id: 'p1',
      sku: 'S2',
      color: 'أحمر',
      size: null,
      price: 333,
      min_stock: 0,
      stock_qty: 50,
      is_active: true,
      change_seq: 1,
    },
  ])
  await db.customers.put({
    id: 'c',
    name: 'زبون',
    shop_name: null,
    phone: null,
    area: null,
    address: null,
    notes: null,
    opening_balance: 0,
    search_text: 'زبون',
    is_active: true,
    balance: 0,
    change_seq: 1,
  })
})

const sale = (discount = 0, paid = 0) =>
  confirmSale({
    customerId: 'c',
    lines: [
      { variantId: 'v1', qty: 3 },
      { variantId: 'v2', qty: 7 },
    ],
    discount,
    paid,
    method: 'cash',
  })

const lineIds = async (invoiceId: string) =>
  (await db.invoice_lines.where('invoice_id').equals(invoiceId).sortBy('sort_order')).map(
    (l) => l.id,
  )

describe('return commands on the device', () => {
  it('a waiting return credits the customer and puts restocked goods back on the shelf', async () => {
    const { invoiceId } = await sale() // 3 x 10.00 + 7 x 3.33 = 53.31
    const [a] = await lineIds(invoiceId)
    const { number, total } = await createReturn({
      invoiceId,
      reason: 'كسر',
      lines: [{ invoiceLineId: a!, qty: 2, disposition: 'restock' }],
    })
    expect(number).toBe('RET-000001')
    expect(total).toBe(2000)
    const pending = await pendingCommands()
    const customer = (await db.customers.get('c'))!
    expect(effectiveBalance('c', customer.balance, pending)).toBe(5331 - 2000)
    expect(effectiveStock('v1', 50, pending)).toBe(50 - 3 + 2)
  })

  it('damaged goods credit the customer but not the shelf', async () => {
    const { invoiceId } = await sale()
    const [a] = await lineIds(invoiceId)
    await createReturn({
      invoiceId,
      lines: [{ invoiceLineId: a!, qty: 1, disposition: 'damaged' }],
    })
    const pending = await pendingCommands()
    expect(effectiveStock('v1', 50, pending)).toBe(50 - 3)
    expect(effectiveBalance('c', 0, pending)).toBe(5331 - 1000)
  })

  it('writes rows at once (change_seq 0) and shows the return on the invoice', async () => {
    const { invoiceId } = await sale()
    const [a] = await lineIds(invoiceId)
    await createReturn({
      invoiceId,
      lines: [{ invoiceLineId: a!, qty: 1, disposition: 'restock' }],
    })
    expect(await db.returns.count()).toBe(1)
    expect((await db.returns.toArray())[0]!.change_seq).toBe(0)
    const snapshot = await loadSalesSnapshot()
    const detail = buildInvoiceDetail(snapshot, invoiceId)!
    expect(detail.returns.map((r) => r.total)).toEqual([1000])
    expect(detail.canCancel).toBe(false)
    expect(detail.canReturn).toBe(true)
    expect(buildReturnList(snapshot, { customerId: 'c' })).toHaveLength(1)
  })

  it('refuses more than what is left, a repeated line, nothing at all and a cancelled invoice', async () => {
    const { invoiceId } = await sale()
    const [a, b] = await lineIds(invoiceId)
    const pick = (id: string, qty: number) => ({
      invoiceLineId: id,
      qty,
      disposition: 'restock' as const,
    })
    await expect(createReturn({ invoiceId, lines: [pick(a!, 4)] })).rejects.toMatchObject({
      code: 'BAD_RETURN_QTY',
    })
    await expect(createReturn({ invoiceId, lines: [pick(a!, 0)] })).rejects.toThrow()
    await expect(createReturn({ invoiceId, lines: [pick(a!, 1), pick(a!, 1)] })).rejects.toThrow()
    await expect(createReturn({ invoiceId, lines: [] })).rejects.toMatchObject({
      code: 'EMPTY_RETURN',
    })
    await createReturn({ invoiceId, lines: [pick(a!, 3)] })
    await expect(createReturn({ invoiceId, lines: [pick(a!, 1)] })).rejects.toMatchObject({
      code: 'BAD_RETURN_QTY',
    })
    expect(await db.returns.count()).toBe(1) // the refused ones left nothing behind
    await createReturn({ invoiceId, lines: [pick(b!, 1)] })
    expect(await db.returns.count()).toBe(2)
  })

  it('a cancelled invoice cannot be returned from, and an invoice with returns cannot be cancelled', async () => {
    const first = await sale()
    const second = await sale()
    const [a] = await lineIds(first.invoiceId)
    await cancelInvoice(second.invoiceId, 'خطأ', false)
    const [b] = await lineIds(second.invoiceId)
    await expect(
      createReturn({
        invoiceId: second.invoiceId,
        lines: [{ invoiceLineId: b!, qty: 1, disposition: 'restock' }],
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_CANCELLED' })
    await createReturn({
      invoiceId: first.invoiceId,
      lines: [{ invoiceLineId: a!, qty: 1, disposition: 'restock' }],
    })
    await expect(cancelInvoice(first.invoiceId, 'خطأ', false)).rejects.toMatchObject({
      code: 'HAS_RETURNS',
    })
  })

  it('discarding a refused return removes the rows it made, and only those', async () => {
    const { invoiceId } = await sale()
    const [a] = await lineIds(invoiceId)
    const { returnId } = await createReturn({
      invoiceId,
      lines: [{ invoiceLineId: a!, qty: 1, disposition: 'restock' }],
    })
    const command = (await pendingCommands()).find((c) => c.type === 'return.create')!
    await markRejected(command.id, { code: 'QTY_EXCEEDS_SOLD', message: 'x', details: {} })
    // a refused return stops counting at once, even before it is discarded
    const snapshot = await loadSalesSnapshot()
    expect(buildReturnList(snapshot, { customerId: 'c' })).toHaveLength(0)
    expect(buildInvoiceDetail(snapshot, invoiceId)!.canCancel).toBe(true)
    await discard(command.id)
    expect(await db.returns.get(returnId)).toBeUndefined()
    expect(await db.return_lines.count()).toBe(0)
    expect(await db.invoices.get(invoiceId)).toBeTruthy()
  })

  it('never touches a return row the server already confirmed', async () => {
    const { invoiceId } = await sale()
    const [a] = await lineIds(invoiceId)
    const { returnId } = await createReturn({
      invoiceId,
      lines: [{ invoiceLineId: a!, qty: 1, disposition: 'restock' }],
    })
    await db.returns.update(returnId, { change_seq: 9 })
    const command = (await pendingCommands()).find((c) => c.type === 'return.create')!
    await markRejected(command.id, { code: 'X', message: 'x', details: {} })
    await discard(command.id)
    expect(await db.returns.get(returnId)).toBeTruthy()
  })

  it('retrying a duplicate return number takes a fresh one, on the command and on the row', async () => {
    const { invoiceId } = await sale()
    const [a] = await lineIds(invoiceId)
    const { returnId, number } = await createReturn({
      invoiceId,
      lines: [{ invoiceLineId: a!, qty: 1, disposition: 'restock' }],
    })
    const command = (await pendingCommands()).find((c) => c.type === 'return.create')!
    await markRejected(command.id, { code: 'DUPLICATE_NUMBER', message: 'x', details: { number } })
    await retry(command.id)
    const again = (await pendingCommands()).find((c) => c.type === 'return.create')!
    expect(again.id).not.toBe(command.id)
    expect((again.payload as ReturnCreatePayload).number).toBe('RET-000002')
    expect((await db.returns.get(returnId))?.number).toBe('RET-000002')
  })
})

describe('statement', () => {
  it('lists a return as a credit labelled مرتجع, and the closing is the balance', async () => {
    const { invoiceId } = await sale()
    const [a] = await lineIds(invoiceId)
    const { number } = await createReturn({
      invoiceId,
      lines: [{ invoiceLineId: a!, qty: 1, disposition: 'restock' }],
    })
    const snapshot = await loadSalesSnapshot()
    const doc = statementDocument(
      snapshot,
      'c',
      '2000-01-01',
      '2999-12-31',
      false,
      DEFAULT_SETTINGS,
    )!
    const row = doc.rows.at(-1)!
    expect([row.label, row.number, row.debit, row.credit]).toEqual([
      'مرتجع',
      number,
      null,
      '₪ 10.00',
    ])
    expect(doc.totals.closing).toBe(row.balance)
    expect(row.balance).toBe('₪ 43.31') // 53.31 - 10.00
  })
})

describe('partial returns of a discounted invoice credit exactly its total (SPEC milestone 7)', () => {
  it('in several returns, with a mix of restock and damaged', async () => {
    const { invoiceId } = await sale(777, 1000)
    const invoice = (await db.invoices.get(invoiceId))!
    const [a, b] = await lineIds(invoiceId)
    const plan = [
      [
        { invoiceLineId: a!, qty: 1, disposition: 'restock' as const },
        { invoiceLineId: b!, qty: 3, disposition: 'damaged' as const },
      ],
      [{ invoiceLineId: b!, qty: 2, disposition: 'restock' as const }],
      [
        { invoiceLineId: a!, qty: 2, disposition: 'restock' as const },
        { invoiceLineId: b!, qty: 2, disposition: 'restock' as const },
      ],
    ]
    let credited = 0
    for (const lines of plan) credited += (await createReturn({ invoiceId, lines })).total
    expect(credited).toBe(invoice.total)
    const pending = await pendingCommands()
    expect(effectiveBalance('c', 0, pending)).toBe(invoice.total - 1000 - credited)
    // nothing left to return
    const detail = buildInvoiceDetail(await loadSalesSnapshot(), invoiceId)!
    expect(detail.canReturn).toBe(false)
  })

  it('the amount of every part follows the shared rule', () => {
    // 7 units worth 23.31 less a 7.77 share: three parts, the last takes the rest
    const net = 2331 - 777
    const parts = [3, 2, 2]
    let qty = 0
    let amount = 0
    for (const part of parts) {
      amount += returnLineAmount(2331, 777, 7, qty, amount, part)
      qty += part
    }
    expect(amount).toBe(net)
  })
})
