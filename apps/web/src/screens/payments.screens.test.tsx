import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, setMeta, wipeLocalData, type DbCustomer, type DbVariant } from '../db'
import { ar } from '../i18n/ar'
import { cancelInvoice, confirmSale, recordPayment, voidPayment } from '../lib/sales'
import { pendingCommands } from '../lib/sync/outbox'
import Payment from './customers/Payment'
import { CustomerProfile } from './customers/CustomerProfile'

const customer: DbCustomer = {
  id: 'c-1',
  name: 'أحمد',
  shop_name: null,
  phone: null,
  area: null,
  address: null,
  notes: null,
  opening_balance: 15000,
  search_text: 'احمد',
  is_active: true,
  balance: 15000,
  change_seq: 2,
}

const variant: DbVariant = {
  id: 'v1',
  product_id: 'p1',
  sku: 'SKU-v1',
  color: 'أسود',
  size: null,
  price: 4500,
  min_stock: 1,
  stock_qty: 10,
  is_active: true,
  change_seq: 1,
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}

const renderApp = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="customers/:customerId/payment" element={<Payment />} />
        <Route path="customers/:customerId" element={<CustomerProfile />} />
      </Routes>
    </MemoryRouter>,
  )

const where = () => screen.getByTestId('where').textContent
const sell = () =>
  confirmSale({
    customerId: 'c-1',
    lines: [{ variantId: 'v1', qty: 2 }],
    discount: 0,
    paid: 3000,
    method: 'cash',
  })

beforeEach(async () => {
  await wipeLocalData()
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
  await setMeta('identity', { user: { id: 'u', name: 'Rep' }, device: { id: 'd1', name: 'iPad' } })
  await db.products.put({
    id: 'p1',
    category_id: 'cat',
    name: 'أرجيلة كبيرة',
    description: null,
    search_text: 'ارجيله',
    is_active: true,
    change_seq: 1,
  })
  await db.variants.put(variant)
  await db.customers.put(customer)
})

afterEach(() => cleanup())

describe('payment screen', () => {
  it('shows the balance before and after, asks to confirm, then saves offline and queues it', async () => {
    renderApp('/customers/c-1/payment')
    const amount = await screen.findByLabelText(ar.payment.amount)
    const confirm = screen.getByRole('button', { name: ar.payment.confirm }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(amount, { target: { value: '40' } })
    expect(screen.getByText(/110\.00/)).toBeTruthy() // 150.00 owed, 40.00 paid
    fireEvent.click(confirm)
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByText(/40\.00/)).toBeTruthy()
    fireEvent.click(within(sheet).getByRole('button', { name: ar.payment.confirm }))
    await waitFor(() => expect(where()).toBe('/customers/c-1'))
    const [command] = await pendingCommands()
    expect(command?.type).toBe('payment.create')
    expect(command?.payload).toMatchObject({
      customer_id: 'c-1',
      amount: 4000,
      method: 'cash',
      number: 'REC-000001',
    })
    const row = (await db.payments.toArray())[0]
    expect(row).toMatchObject({ invoice_id: null, amount: 4000, status: 'active', change_seq: 0 })
    // the profile shows the new balance at once, and the payment marked as not sent
    expect(await screen.findByText(ar.payment.unsent)).toBeTruthy()
    expect(screen.getByText(/عليه.*110\.00/)).toBeTruthy()
    expect(screen.getByText(/دفعة مستقلة/)).toBeTruthy()
  })

  it('refuses zero, a bad amount, a cheque with no details and a future day', async () => {
    renderApp('/customers/c-1/payment')
    const amount = await screen.findByLabelText(ar.payment.amount)
    const confirm = screen.getByRole('button', { name: ar.payment.confirm }) as HTMLButtonElement
    fireEvent.change(amount, { target: { value: '0' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(amount, { target: { value: 'abc' } })
    expect(screen.getByText(ar.payment.badAmount)).toBeTruthy()
    fireEvent.change(amount, { target: { value: '10' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: ar.invoices.method.cheque }))
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(ar.checkout.chequeNote), {
      target: { value: 'شيك 55' },
    })
    expect(confirm.disabled).toBe(false)
    fireEvent.change(screen.getByLabelText(ar.payment.date), { target: { value: '2999-01-01' } })
    expect(confirm.disabled).toBe(true)
    expect(screen.getByText(ar.payment.badDate)).toBeTruthy()
  })

  it('more than he owes warns that he will have credit, and is allowed', async () => {
    renderApp('/customers/c-1/payment')
    fireEvent.change(await screen.findByLabelText(ar.payment.amount), { target: { value: '200' } })
    expect(screen.getByRole('status').textContent).toContain('50.00')
    const confirm = screen.getByRole('button', { name: ar.payment.confirm }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
  })

  it('an unknown customer says so', async () => {
    renderApp('/customers/nope/payment')
    expect(await screen.findByText(ar.customers.notFound)).toBeTruthy()
  })
})

describe('voiding a payment', () => {
  it('asks for a reason, keeps the record, and the balance comes back at once', async () => {
    const { paymentId } = await recordPayment({ customerId: 'c-1', amount: 4000, method: 'cash' })
    await db.payments.update(paymentId, { change_seq: 9 }) // as if the server had it
    await db.customers.update('c-1', { balance: 11000 })
    await db.outbox.clear()
    renderApp('/customers/c-1')
    fireEvent.click(await screen.findByRole('button', { name: ar.payment.voidAction }))
    const sheet = await screen.findByRole('dialog')
    const confirm = within(sheet).getByRole('button', {
      name: ar.payment.voidConfirm,
    }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(within(sheet).getByLabelText(ar.payment.voidReason), {
      target: { value: 'كتبتها بالغلط' },
    })
    await waitFor(() => expect(confirm.disabled).toBe(false))
    fireEvent.click(confirm)
    await waitFor(async () =>
      expect((await pendingCommands()).map((c) => c.type)).toEqual(['payment.void']),
    )
    expect(await screen.findByText(ar.payment.voided)).toBeTruthy()
    expect(screen.getByText(ar.payment.voidWaiting)).toBeTruthy()
    expect(screen.getByText(/كتبتها بالغلط/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: ar.payment.voidAction })).toBeNull() // once only
    expect(screen.getByText(/عليه.*150\.00/)).toBeTruthy() // back to what he owed
  })

  it('a payment taken with an invoice can be voided from the profile too', async () => {
    await sell()
    renderApp('/customers/c-1')
    expect(await screen.findByText(/مع الفاتورة INV-000001/)).toBeTruthy()
    expect(screen.getByRole('button', { name: ar.payment.voidAction })).toBeTruthy()
  })

  it('cancelling an invoice after voiding its payment does not hand the money back twice', async () => {
    const { invoiceId } = await sell()
    const payment = (await db.payments.toArray())[0]!
    await voidPayment(payment.id, 'خطأ')
    await cancelInvoice(invoiceId, 'خطأ', true)
    const cancel = (await pendingCommands()).find((c) => c.type === 'invoice.cancel')
    expect(cancel?.payload).toMatchObject({ payment_amount: 0, void_payment: true })
  })

  it('a payment the server refused is marked and cannot be voided', async () => {
    await recordPayment({ customerId: 'c-1', amount: 1000, method: 'cash' })
    const [command] = await pendingCommands()
    await db.outbox
      .where('id')
      .equals(command!.id)
      .modify({
        status: 'rejected',
        error: { code: 'CUSTOMER_NOT_FOUND', message: 'x', details: {} },
      })
    renderApp('/customers/c-1')
    expect(await screen.findByText(ar.payment.refused)).toBeTruthy()
    expect(screen.queryByRole('button', { name: ar.payment.voidAction })).toBeNull()
    expect(screen.getByText(/عليه.*150\.00/)).toBeTruthy() // it never counted
  })
})
