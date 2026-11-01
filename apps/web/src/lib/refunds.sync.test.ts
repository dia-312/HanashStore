import { beforeEach, describe, expect, it } from 'vitest'
import { db, setMeta, wipeLocalData } from '../db'
import { statementDocument } from './documents'
import { buildPaymentList, effectiveBalances, loadSalesSnapshot } from './localSales'
import { confirmSale, createReturn, recordRefund, voidPayment } from './sales'
import { DEFAULT_SETTINGS } from './settings'
import type { RefundCreatePayload } from './sync/commands'
import { effectiveBalance } from './sync/effectiveBalance'
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
  await db.variants.put({
    id: 'v1',
    product_id: 'p1',
    sku: 'S1',
    color: null,
    size: null,
    price: 2500,
    min_stock: 0,
    stock_qty: 50,
    is_active: true,
    change_seq: 1,
  })
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

// 4 x 25.00 = 100.00, 30.00 paid with it, then all four taken back: he is owed the 30.00
const paidThenReturned = async () => {
  const { invoiceId } = await confirmSale({
    customerId: 'c',
    lines: [{ variantId: 'v1', qty: 4 }],
    discount: 0,
    paid: 3000,
    method: 'cash',
  })
  const line = (await db.invoice_lines.where('invoice_id').equals(invoiceId).first())!
  await createReturn({
    invoiceId,
    lines: [{ invoiceLineId: line.id, qty: 4, disposition: 'restock' }],
  })
}

describe('refund commands on the device', () => {
  it('the credit left by a returned paid invoice is cleared by a refund', async () => {
    await paidThenReturned()
    const balance = async () => effectiveBalance('c', 0, await pendingCommands())
    expect(await balance()).toBe(-3000)
    const { number } = await recordRefund({ customerId: 'c', amount: 3000, method: 'cash' })
    expect(number).toBe('REF-000001')
    expect(await balance()).toBe(0)
  })

  it('writes a row at once marked as a refund and lists it with the payments', async () => {
    const { refundId } = await recordRefund({ customerId: 'c', amount: 700, method: 'transfer' })
    const row = (await db.payments.get(refundId))!
    expect(row).toMatchObject({ kind: 'refund', invoice_id: null, amount: 700, change_seq: 0 })
    const list = buildPaymentList(await loadSalesSnapshot(), 'c')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'refund', sendState: 'pending', canVoid: true })
  })

  it('refuses zero, a cheque with no details and an unknown customer, leaving nothing behind', async () => {
    await expect(recordRefund({ customerId: 'c', amount: 0, method: 'cash' })).rejects.toThrow()
    await expect(recordRefund({ customerId: 'c', amount: 5, method: 'cheque' })).rejects.toThrow()
    await expect(recordRefund({ customerId: 'x', amount: 5, method: 'cash' })).rejects.toThrow()
    expect(await db.payments.count()).toBe(0)
    expect(await pendingCommands()).toHaveLength(0)
  })

  it('voiding a refund takes it off again: the credit comes back', async () => {
    await paidThenReturned()
    const { refundId } = await recordRefund({ customerId: 'c', amount: 3000, method: 'cash' })
    await voidPayment(refundId, 'سجلتها بالغلط')
    expect(effectiveBalance('c', 0, await pendingCommands())).toBe(-3000)
    const [item] = buildPaymentList(await loadSalesSnapshot(), 'c').filter((p) => p.id === refundId)
    expect(item).toMatchObject({ kind: 'refund', status: 'voided', voidPending: true })
  })

  it('a refused refund stops counting at once, and discarding it removes its row', async () => {
    const { refundId } = await recordRefund({ customerId: 'c', amount: 500, method: 'cash' })
    const command = (await pendingCommands())[0]!
    await markRejected(command.id, { code: 'CUSTOMER_NOT_FOUND', message: 'x', details: {} })
    const snapshot = await loadSalesSnapshot()
    expect(effectiveBalances(snapshot).get('c')).toBe(0)
    await discard(command.id)
    expect(await db.payments.get(refundId)).toBeUndefined()
  })

  it('never touches a refund row the server already confirmed', async () => {
    const { refundId } = await recordRefund({ customerId: 'c', amount: 500, method: 'cash' })
    await db.payments.update(refundId, { change_seq: 9 })
    const command = (await pendingCommands())[0]!
    await markRejected(command.id, { code: 'X', message: 'x', details: {} })
    await discard(command.id)
    expect(await db.payments.get(refundId)).toBeTruthy()
  })

  it('retrying a duplicate number takes a fresh REF number on the command and the row', async () => {
    const { refundId, number } = await recordRefund({
      customerId: 'c',
      amount: 500,
      method: 'cash',
    })
    const command = (await pendingCommands())[0]!
    await markRejected(command.id, { code: 'DUPLICATE_NUMBER', message: 'x', details: { number } })
    await retry(command.id)
    const again = (await pendingCommands())[0]!
    expect((again.payload as RefundCreatePayload).number).toBe('REF-000002')
    expect((await db.payments.get(refundId))?.number).toBe('REF-000002')
  })
})

describe('statement', () => {
  it('shows a refund as a debit labelled استرداد, and a voided one only on request', async () => {
    await paidThenReturned()
    const { refundId } = await recordRefund({ customerId: 'c', amount: 3000, method: 'cash' })
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
    expect([row.label, row.debit, row.credit, row.balance]).toEqual([
      'استرداد',
      '₪ 30.00',
      null,
      '₪ 0.00',
    ])
    expect(doc.totals.closing).toBe('₪ 0.00')

    await voidPayment(refundId, 'خطأ')
    const after = await loadSalesSnapshot()
    const hidden = statementDocument(
      after,
      'c',
      '2000-01-01',
      '2999-12-31',
      false,
      DEFAULT_SETTINGS,
    )!
    expect(hidden.rows.some((r) => r.label.startsWith('استرداد'))).toBe(false)
    expect(hidden.totals.closing).toBe('-₪ 30.00')
    const shown = statementDocument(after, 'c', '2000-01-01', '2999-12-31', true, DEFAULT_SETTINGS)!
    expect(shown.rows.at(-1)!.label).toBe('استرداد ملغى')
    expect(shown.totals.closing).toBe(hidden.totals.closing)
  })
})
