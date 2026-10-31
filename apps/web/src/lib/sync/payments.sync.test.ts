import { beforeEach, describe, expect, it } from 'vitest'
import { db, setMeta, wipeLocalData } from '../../db'
import { recordPayment, voidPayment } from '../sales'
import { effectiveBalance } from './effectiveBalance'
import type { PaymentCreatePayload } from './commands'
import { discard, markRejected, pendingCommands, retry } from './outbox'

beforeEach(async () => {
  await wipeLocalData()
  await setMeta('identity', { user: { id: 'u', name: 'Rep' }, device: { id: 'd1', name: 'iPad' } })
  await db.customers.put({
    id: 'c',
    name: 'زبون',
    shop_name: null,
    phone: null,
    area: null,
    address: null,
    notes: null,
    opening_balance: 10000,
    search_text: 'زبون',
    is_active: true,
    balance: 10000,
    change_seq: 1,
  })
})

describe('payment commands on the device', () => {
  it('a waiting payment lowers the shown balance and a waiting void puts it back', async () => {
    const { paymentId } = await recordPayment({ customerId: 'c', amount: 4000, method: 'transfer' })
    expect(effectiveBalance('c', 10000, await pendingCommands())).toBe(6000)
    await voidPayment(paymentId, 'خطأ')
    expect(effectiveBalance('c', 10000, await pendingCommands())).toBe(10000)
  })

  it('numbers go up one by one and a payment cannot be zero or a cheque with no details', async () => {
    const a = await recordPayment({ customerId: 'c', amount: 100, method: 'cash' })
    const b = await recordPayment({ customerId: 'c', amount: 100, method: 'cash' })
    expect([a.number, b.number]).toEqual(['REC-000001', 'REC-000002'])
    await expect(recordPayment({ customerId: 'c', amount: 0, method: 'cash' })).rejects.toThrow()
    await expect(recordPayment({ customerId: 'c', amount: 5, method: 'cheque' })).rejects.toThrow()
    await expect(recordPayment({ customerId: 'nope', amount: 5, method: 'cash' })).rejects.toThrow()
    expect(await db.payments.count()).toBe(2) // the refused ones left nothing behind
  })

  it('a payment dated another day is stored on that day', async () => {
    const { paymentId } = await recordPayment({
      customerId: 'c',
      amount: 100,
      method: 'cash',
      day: '2026-03-04',
    })
    expect((await db.payments.get(paymentId))?.paid_at.slice(0, 10)).toBe('2026-03-04')
  })

  it('discarding a refused payment removes the row it made, and only that', async () => {
    const { paymentId } = await recordPayment({ customerId: 'c', amount: 100, method: 'cash' })
    const [command] = await pendingCommands()
    await markRejected(command!.id, { code: 'CUSTOMER_NOT_FOUND', message: 'x', details: {} })
    await discard(command!.id)
    expect(await db.payments.get(paymentId)).toBeUndefined()
    expect(await db.outbox.count()).toBe(0)
    expect(await db.customers.get('c')).toBeTruthy()
  })

  it('never touches a payment row the server already confirmed', async () => {
    const { paymentId } = await recordPayment({ customerId: 'c', amount: 100, method: 'cash' })
    await db.payments.update(paymentId, { change_seq: 7 })
    const [command] = await pendingCommands()
    await markRejected(command!.id, { code: 'X', message: 'x', details: {} })
    await discard(command!.id)
    expect(await db.payments.get(paymentId)).toBeTruthy()
  })

  it('retrying a duplicate receipt number takes a fresh one, on the command and on the row', async () => {
    const { paymentId, number } = await recordPayment({
      customerId: 'c',
      amount: 100,
      method: 'cash',
    })
    const [command] = await pendingCommands()
    await markRejected(command!.id, {
      code: 'DUPLICATE_NUMBER',
      message: 'x',
      details: { number },
    })
    await retry(command!.id)
    const [again] = await pendingCommands()
    expect(again!.id).not.toBe(command!.id)
    const payload = again!.payload as PaymentCreatePayload
    expect(payload.number).toBe('REC-000002')
    expect(payload.payment_id).toBe(paymentId)
    expect((await db.payments.get(paymentId))?.number).toBe('REC-000002')
  })
})
