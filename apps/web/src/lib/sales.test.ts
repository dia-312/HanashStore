import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, setMeta, wipeLocalData, type DbCustomer, type DbVariant } from '../db'
import { clampQty, clearCart, getCart, moveCartToCustomer, setLineQty } from './cart'
import { fetchServerNumbers, raiseCounters, takeNumber } from './counters'
import {
  buildCustomerList,
  buildCustomerProfile,
  buildInvoiceDetail,
  buildInvoiceList,
  loadSalesSnapshot,
} from './localSales'
import { SaleError, cancelInvoice, confirmSale, markDelivered, saveCustomer } from './sales'
import { effectiveBalance, pendingBalances } from './sync/effectiveBalance'
import { effectiveStock } from './sync/effectiveStock'
import { discard, enqueue, markRejected, pendingCommands, retry } from './sync/outbox'
import { pushPending } from './sync/push'
import type { InvoiceCreatePayload } from './sync/commands'

const variant = (id: string, extra: Partial<DbVariant> = {}): DbVariant => ({
  id,
  product_id: 'p1',
  sku: `SKU-${id}`,
  color: 'أسود',
  size: null,
  price: 4500,
  min_stock: 1,
  stock_qty: 10,
  is_active: true,
  change_seq: 1,
  ...extra,
})

const customerRow = (id: string, extra: Partial<DbCustomer> = {}): DbCustomer => ({
  id,
  name: 'أحمد',
  shop_name: null,
  phone: null,
  area: null,
  address: null,
  notes: null,
  opening_balance: 0,
  search_text: 'احمد',
  is_active: true,
  balance: 0,
  change_seq: 3,
  ...extra,
})

beforeEach(async () => {
  await wipeLocalData()
  await setMeta('identity', { user: { id: 'u', name: 'Rep' }, device: { id: 'd1', name: 'iPad' } })
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true }) // no real sending
  await db.products.put({
    id: 'p1',
    category_id: 'c1',
    name: 'أرجيلة كبيرة',
    description: null,
    search_text: 'ارجيله كبيره',
    is_active: true,
    change_seq: 1,
  })
  await db.variants.bulkPut([variant('v1'), variant('v2', { price: 2000, stock_qty: 3 })])
  await db.customers.put(customerRow('c-1', { balance: 1000, opening_balance: 1000 }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const sale = (extra: Partial<Parameters<typeof confirmSale>[0]> = {}) =>
  confirmSale({
    customerId: 'c-1',
    lines: [{ variantId: 'v1', qty: 2 }],
    discount: 0,
    paid: 0,
    method: 'cash',
    ...extra,
  })

describe('confirming a sale (works offline)', () => {
  it('writes the invoice, lines and payment, queues one command, and empties the cart', async () => {
    await setLineQty('c-1', 'v1', 2)
    const { invoiceId, number } = await sale({ discount: 500, paid: 3000, method: 'transfer' })
    expect(number).toBe('INV-000001')

    const invoice = await db.invoices.get(invoiceId)
    expect(invoice).toMatchObject({ subtotal: 9000, discount: 500, total: 8500, change_seq: 0 })
    const lines = await db.invoice_lines.where('invoice_id').equals(invoiceId).toArray()
    expect(lines).toMatchObject([
      {
        qty: 2,
        unit_price: 4500,
        line_total: 9000,
        discount_share: 500,
        product_name: 'أرجيلة كبيرة',
        variant_label: 'أسود',
      },
    ])
    const payments = await db.payments.where('invoice_id').equals(invoiceId).toArray()
    expect(payments).toMatchObject([{ amount: 3000, method: 'transfer', number: 'REC-000001' }])
    const commands = await pendingCommands()
    expect(commands).toHaveLength(1)
    const payload = commands[0]!.payload as InvoiceCreatePayload
    expect(commands[0]!.type).toBe('invoice.create')
    expect(payload).toMatchObject({ number: 'INV-000001', discount: 500, customer_id: 'c-1' })
    expect(payload.payment).toMatchObject({ amount: 3000, method: 'transfer' })
    expect(await getCart('c-1')).toBeUndefined()
  })

  it('numbers go up by one for every sale, payments only count when there is one', async () => {
    const a = await sale({ paid: 100 })
    const b = await sale()
    const c = await sale({ paid: 100 })
    expect([a.number, b.number, c.number]).toEqual(['INV-000001', 'INV-000002', 'INV-000003'])
    const receipts = (await db.payments.toArray()).map((p) => p.number).sort()
    expect(receipts).toEqual(['REC-000001', 'REC-000002'])
  })

  it('the shelf shrinks at once and the balance grows by what is still owed', async () => {
    await sale({ paid: 2000 })
    const commands = await pendingCommands()
    expect(effectiveStock('v1', 10, commands)).toBe(8)
    expect(effectiveBalance('c-1', 1000, commands)).toBe(1000 + 9000 - 2000)
  })

  it('refuses more than the shelf holds, counting what is already waiting', async () => {
    await sale({ lines: [{ variantId: 'v2', qty: 2 }] })
    await expect(sale({ lines: [{ variantId: 'v2', qty: 2 }] })).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      available: 1,
    })
    expect(await db.invoices.count()).toBe(1) // nothing from the refused sale was saved
    expect(await pendingCommands()).toHaveLength(1)
  })

  it('the same variant in two lines must fit as a whole', async () => {
    await expect(
      sale({
        lines: [
          { variantId: 'v2', qty: 2 },
          { variantId: 'v2', qty: 2 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' })
  })

  it.each([
    ['a discount above the subtotal', { discount: 9001 }, 'BAD_DISCOUNT'],
    ['no customer', { customerId: null }, 'NO_CUSTOMER'],
    ['an empty cart', { lines: [] }, 'EMPTY_CART'],
    ['a cheque without details', { paid: 100, method: 'cheque' as const }, 'CHEQUE_NOTE'],
    ['an unknown variant', { lines: [{ variantId: 'ghost', qty: 1 }] }, 'UNKNOWN_VARIANT'],
    ['a payment with a fraction', { paid: 10.5 }, 'BAD_PAYMENT'],
  ])('refuses %s and uses up no number', async (_name, extra, code) => {
    await expect(sale(extra)).rejects.toBeInstanceOf(SaleError)
    await expect(sale(extra)).rejects.toMatchObject({ code })
    expect((await sale()).number).toBe('INV-000001')
  })

  it('a cheque with its details is accepted', async () => {
    await expect(
      sale({ paid: 100, method: 'cheque', payNote: '123 بنك فلسطين' }),
    ).resolves.toBeTruthy()
  })

  it('paying more than the total is fine and leaves the customer in credit', async () => {
    await sale({ paid: 20000 })
    const commands = await pendingCommands()
    expect(effectiveBalance('c-1', 1000, commands)).toBe(1000 + 9000 - 20000)
  })

  it('takes the price from the device now and freezes it in the line', async () => {
    await db.variants.update('v1', { price: 5000 })
    const { invoiceId } = await sale()
    await db.variants.update('v1', { price: 9999 })
    const [line] = await db.invoice_lines.where('invoice_id').equals(invoiceId).toArray()
    expect(line?.unit_price).toBe(5000)
  })
})

describe('customers', () => {
  it('a new customer is saved on the device at once with his opening balance, and queued', async () => {
    const id = await saveCustomer({ name: ' أحمد  علي ', phone: '0599', openingBalance: 25000 })
    const row = await db.customers.get(id)
    expect(row).toMatchObject({
      name: 'أحمد علي',
      balance: 25000,
      opening_balance: 25000,
      change_seq: 0,
    })
    expect(row?.search_text).toContain('احمد')
    expect((await pendingCommands())[0]?.type).toBe('customer.upsert')
  })

  it('editing keeps the opening balance and the server balance', async () => {
    await saveCustomer({ id: 'c-1', name: 'أحمد الجديد', openingBalance: 99999 })
    const row = await db.customers.get('c-1')
    expect(row).toMatchObject({
      name: 'أحمد الجديد',
      opening_balance: 1000,
      balance: 1000,
      change_seq: 3,
    })
  })

  it('discarding a customer the server never accepted removes his optimistic row', async () => {
    const id = await saveCustomer({ name: 'جديد' })
    const [command] = await pendingCommands()
    await markRejected(command!.id, { code: 'VALIDATION_ERROR', message: 'x', details: {} })
    await discard(command!.id)
    expect(await db.customers.get(id)).toBeUndefined()
    expect(await db.customers.get('c-1')).toBeDefined()
  })
})

describe('what the screens show', () => {
  it('the customer list adds waiting sales to the server balance and sorts three ways', async () => {
    await db.customers.bulkPut([
      customerRow('c-2', { name: 'بلال', search_text: 'بلال', balance: 500 }),
      customerRow('c-3', { name: 'تامر', search_text: 'تامر', balance: -200 }),
    ])
    await sale({ paid: 1000 }) // c-1 owes 1000 + 9000 - 1000
    const snapshot = await loadSalesSnapshot()
    expect(buildCustomerList(snapshot).map((c) => [c.name, c.balance])).toEqual([
      ['أحمد', 9000],
      ['بلال', 500],
      ['تامر', -200],
    ])
    expect(buildCustomerList(snapshot, { sort: 'balance' }).map((c) => c.name)).toEqual([
      'أحمد',
      'بلال',
      'تامر',
    ])
    expect(buildCustomerList(snapshot, { sort: 'lastInvoice' })[0]?.name).toBe('أحمد')
    expect(buildCustomerList(snapshot, { q: 'بلال' }).map((c) => c.name)).toEqual(['بلال'])
  })

  it('a rejected sale stops counting in the balance and shows as not sent', async () => {
    const { invoiceId } = await sale()
    const [command] = await pendingCommands()
    await markRejected(command!.id, { code: 'CUSTOMER_INACTIVE', message: 'x', details: {} })
    const snapshot = await loadSalesSnapshot()
    expect(buildCustomerList(snapshot)[0]?.balance).toBe(1000)
    expect(buildInvoiceList(snapshot)[0]).toMatchObject({ id: invoiceId, sendState: 'rejected' })
    expect(buildInvoiceDetail(snapshot, invoiceId)).toMatchObject({
      rejectedCode: 'CUSTOMER_INACTIVE',
      canCancel: false,
    })
    await discard(command!.id) // giving up removes the invoice that never existed
    expect(await db.invoices.count()).toBe(0)
    expect(await db.invoice_lines.count()).toBe(0)
  })

  it('an invoice shows paid, remaining and its state from what is waiting', async () => {
    const { invoiceId } = await sale({ paid: 3000 })
    let detail = buildInvoiceDetail(await loadSalesSnapshot(), invoiceId)!
    expect([detail.total, detail.paid, detail.remaining, detail.sendState]).toEqual([
      9000,
      3000,
      6000,
      'pending',
    ])
    expect(detail.status).toBe('confirmed')

    await markDelivered(invoiceId)
    detail = buildInvoiceDetail(await loadSalesSnapshot(), invoiceId)!
    expect(detail.delivered).toBe(true)

    await cancelInvoice(invoiceId, 'خطأ بالكمية', true)
    detail = buildInvoiceDetail(await loadSalesSnapshot(), invoiceId)!
    expect(detail).toMatchObject({ status: 'cancelled', paid: 0, cancel_reason: 'خطأ بالكمية' })
  })

  it('cancelling puts the shelf and the balance back, keeping or giving back the payment', async () => {
    const { invoiceId } = await sale({ paid: 3000 })
    await cancelInvoice(invoiceId, 'خطأ', false) // keep the payment as credit
    let commands = await pendingCommands()
    expect(effectiveStock('v1', 10, commands)).toBe(10)
    expect(effectiveBalance('c-1', 1000, commands)).toBe(1000 + 9000 - 3000 - 9000) // credit of 3000 stays

    await db.outbox.clear()
    const second = await sale({ paid: 3000 })
    await cancelInvoice(second.invoiceId, 'خطأ', true) // money given back
    commands = await pendingCommands()
    expect(effectiveBalance('c-1', 1000, commands)).toBe(1000)
  })

  it('filters invoices by customer, delivery, status and date', async () => {
    await db.customers.put(customerRow('c-2', { name: 'بلال', search_text: 'بلال' }))
    const a = await sale()
    await sale({ customerId: 'c-2' })
    await markDelivered(a.invoiceId)
    const s = await loadSalesSnapshot()
    expect(buildInvoiceList(s, { customerId: 'c-2' })).toHaveLength(1)
    expect(buildInvoiceList(s, { delivered: true }).map((i) => i.id)).toEqual([a.invoiceId])
    expect(buildInvoiceList(s, { delivered: false })).toHaveLength(1)
    expect(buildInvoiceList(s, { status: 'cancelled' })).toHaveLength(0)
    const today = new Date().toISOString().slice(0, 10)
    expect(buildInvoiceList(s, { from: today, to: today })).toHaveLength(2)
    expect(buildInvoiceList(s, { from: '2999-01-01' })).toHaveLength(0)
  })

  it('a customer profile lists his invoices and his effective balance', async () => {
    await sale()
    const profile = buildCustomerProfile(await loadSalesSnapshot(), 'c-1')
    expect(profile?.balance).toBe(10000)
    expect(profile?.invoices).toHaveLength(1)
    expect(buildCustomerProfile(await loadSalesSnapshot(), 'nope')).toBeNull()
  })

  it('pending balances only look at the outbox, so optimistic rows are never counted twice', async () => {
    await sale({ paid: 1000 })
    const commands = await pendingCommands()
    const once = pendingBalances(new Map([['c-1', 1000]]), commands).get('c-1')
    expect(once).toBe(1000 + 9000 - 1000)
    expect(await db.invoices.count()).toBe(1) // the optimistic row exists and changes nothing above
  })
})

describe('after the server answers', () => {
  it('an applied sale leaves the outbox and the customer balance becomes the server number', async () => {
    const { invoiceId } = await sale({ paid: 1000 })
    const [command] = await pendingCommands()
    await pushPending(async () => ({
      results: [
        {
          id: command!.id,
          status: 'applied' as const,
          data: {
            customer_id: 'c-1',
            customer_balance: 9000,
            variants: [{ id: 'v1', stock_qty: 8, change_seq: 9 }],
          },
        },
      ],
      cursor: 9,
    }))
    expect(await pendingCommands()).toHaveLength(0)
    expect((await db.customers.get('c-1'))?.balance).toBe(9000)
    expect((await db.variants.get('v1'))?.stock_qty).toBe(8)
    // The rows stay until the pull replaces them with the server's (higher change_seq).
    expect(await db.invoices.get(invoiceId)).toBeDefined()
  })

  it('a refused number is replaced on retry, in the command and in the rows the rep sees', async () => {
    const { invoiceId } = await sale({ paid: 500 })
    const [command] = await pendingCommands()
    const payload = command!.payload as InvoiceCreatePayload
    await markRejected(command!.id, {
      code: 'DUPLICATE_NUMBER',
      message: 'x',
      details: { number: payload.number },
    })
    await retry(command!.id)
    const [again] = await pendingCommands()
    expect(again!.id).not.toBe(command!.id)
    expect((again!.payload as InvoiceCreatePayload).number).toBe('INV-000002')
    expect((await db.invoices.get(invoiceId))?.number).toBe('INV-000002')
    // The payment number was not the problem: it is unchanged.
    expect((again!.payload as InvoiceCreatePayload).payment?.number).toBe('REC-000001')
  })
})

describe('document counters', () => {
  it('start above what the server has seen and never go down', async () => {
    await raiseCounters({ INV: 41, REC: 9 })
    expect(await takeNumber('INV')).toBe('INV-000042')
    expect(await takeNumber('REC')).toBe('REC-000010')
    await raiseCounters({ INV: 5, REC: 5 })
    expect(await takeNumber('INV')).toBe('INV-000043')
  })

  it('asks the server for its highest numbers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ INV: 7, REC: 3 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    expect(await fetchServerNumbers()).toEqual({ INV: 7, REC: 3 })
  })
})

describe('cart', () => {
  it('keeps one cart per customer, and a stepper never goes above the shelf', async () => {
    await setLineQty('c-1', 'v1', 2)
    await setLineQty('c-1', 'v2', 1)
    await setLineQty(null, 'v1', 5)
    expect((await getCart('c-1'))?.lines).toEqual([
      { variant_id: 'v1', qty: 2 },
      { variant_id: 'v2', qty: 1 },
    ])
    expect((await getCart(null))?.lines).toEqual([{ variant_id: 'v1', qty: 5 }])
    expect(clampQty(9, 3)).toBe(3)
    expect(clampQty(-2, 3)).toBe(0)
    expect(clampQty(2.9, 5)).toBe(2)
    expect(clampQty(4, -1)).toBe(0)
  })

  it('changing a quantity keeps its place; zero removes the line; an empty cart disappears', async () => {
    await setLineQty('c-1', 'v1', 1)
    await setLineQty('c-1', 'v2', 1)
    await setLineQty('c-1', 'v1', 4)
    expect((await getCart('c-1'))?.lines.map((l) => [l.variant_id, l.qty])).toEqual([
      ['v1', 4],
      ['v2', 1],
    ])
    await setLineQty('c-1', 'v1', 0)
    await setLineQty('c-1', 'v2', 0)
    expect(await getCart('c-1')).toBeUndefined()
  })

  it('a cart with no customer moves to the customer picked at checkout, merging', async () => {
    await setLineQty(null, 'v1', 2)
    await setLineQty('c-1', 'v1', 1)
    await setLineQty('c-1', 'v2', 1)
    await moveCartToCustomer('c-1')
    expect(await getCart(null)).toBeUndefined()
    expect((await getCart('c-1'))?.lines).toEqual([
      { variant_id: 'v1', qty: 3 },
      { variant_id: 'v2', qty: 1 },
    ])
  })

  it('survives a restart: it is in the database, and clearing it empties it', async () => {
    await setLineQty('c-1', 'v1', 2)
    db.close()
    await db.open()
    expect((await getCart('c-1'))?.lines).toHaveLength(1)
    await clearCart('c-1')
    expect(await getCart('c-1')).toBeUndefined()
  })
})

describe('Dexie version 3', () => {
  it('version 2 data (outbox, catalog, login) survives the move to version 3', async () => {
    await db.delete()
    const old = new Dexie('sales-rep')
    old.version(1).stores({ meta: 'key' })
    old.version(2).stores({
      meta: 'key',
      categories: 'id',
      products: 'id, category_id',
      variants: 'id, product_id',
      images: 'id, product_id',
      outbox: '++seq, &id, status',
    })
    await old.open()
    await old.table('meta').put({ key: 'identity', value: { device: { id: 'keep-me' } } })
    await old.table('outbox').add({
      id: 'cmd-1',
      type: 'stock.damage',
      schema_version: 1,
      payload: { variant_id: 'a' },
      created_at: '2026-11-01T00:00:00Z',
      status: 'pending',
    })
    old.close()

    await db.open()
    expect((await db.meta.get('identity'))?.value).toEqual({ device: { id: 'keep-me' } })
    expect(await pendingCommands()).toHaveLength(1)
    await db.customers.put(customerRow('c-9'))
    await setLineQty('c-9', 'v1', 1)
    expect(await db.customers.count()).toBe(1)
    await setMeta('x', 1)
    await enqueue('stock.damage', { variant_id: 'b' })
  })
})
