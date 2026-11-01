import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, setMeta, wipeLocalData, type DbCustomer, type DbVariant } from '../db'
import { ar, fill } from '../i18n/ar'
import { cancelInvoice, confirmSale, createReturn } from '../lib/sales'
import { pendingCommands } from '../lib/sync/outbox'
import { CustomerProfile } from './customers/CustomerProfile'
import ReturnPick from './customers/ReturnPick'
import InvoiceView from './invoices/InvoiceView'
import Return from './invoices/Return'

const customer: DbCustomer = {
  id: 'c-1',
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
        <Route path="invoices/:invoiceId/return" element={<Return />} />
        <Route path="invoices/:invoiceId" element={<InvoiceView />} />
        <Route path="customers/:customerId/return" element={<ReturnPick />} />
        <Route path="customers/:customerId" element={<CustomerProfile />} />
      </Routes>
    </MemoryRouter>,
  )

const where = () => screen.getByTestId('where').textContent
// 3 x 45.00 = 135.00, a 15.00 discount: 120.00 owed, 20.00 paid
const sell = () =>
  confirmSale({
    customerId: 'c-1',
    lines: [{ variantId: 'v1', qty: 3 }],
    discount: 1500,
    paid: 2000,
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

describe('return screen', () => {
  it('shows the credit worked out with the discount share, asks to confirm, saves offline and queues it', async () => {
    const { invoiceId } = await sell()
    renderApp(`/invoices/${invoiceId}/return`)
    const qty = await screen.findByLabelText(new RegExp(ar.returns.qty))
    const confirm = screen.getByRole('button', { name: ar.returns.confirm }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(qty, { target: { value: '2' } })
    // each unit is worth 45.00 - 5.00 of the discount = 40.00
    expect(screen.getAllByText(/80\.00/, { selector: 'bdi' }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ar.returns.damaged) }))
    fireEvent.click(confirm)
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getAllByText(/80\.00/).length).toBeGreaterThan(0)
    // 100.00 owed (120.00 - 20.00 paid) minus the 80.00 credit
    expect(within(sheet).getByText(/20\.00/)).toBeTruthy()
    fireEvent.click(within(sheet).getByRole('button', { name: ar.returns.confirm }))
    await waitFor(() => expect(where()).toBe(`/invoices/${invoiceId}`))
    const command = (await pendingCommands()).find((c) => c.type === 'return.create')
    expect(command?.payload).toMatchObject({
      invoice_id: invoiceId,
      total: 8000,
      number: 'RET-000001',
      lines: [{ qty: 2, disposition: 'damaged', amount: 8000 }],
    })
    // the invoice screen lists it at once, and its cancel button is gone
    expect(await screen.findByText(ar.returns.list)).toBeTruthy()
    expect(screen.queryByRole('button', { name: ar.invoices.cancel })).toBeNull()
    expect(screen.getByText(ar.returns.cannotCancel)).toBeTruthy()
  })

  it('refuses more than what is left and needs at least one line', async () => {
    const { invoiceId } = await sell()
    renderApp(`/invoices/${invoiceId}/return`)
    const qty = await screen.findByLabelText(new RegExp(ar.returns.qty))
    const confirm = screen.getByRole('button', { name: ar.returns.confirm }) as HTMLButtonElement
    expect(screen.getByText(ar.returns.nothingPicked)).toBeTruthy()
    fireEvent.change(qty, { target: { value: '4' } })
    expect(screen.getByText(ar.returns.badQty)).toBeTruthy()
    expect(confirm.disabled).toBe(true)
    fireEvent.change(qty, { target: { value: '1.5' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(qty, { target: { value: '3' } })
    expect(confirm.disabled).toBe(false)
  })

  it('a second return counts what the first took back, and the last takes the exact remainder', async () => {
    const { invoiceId } = await sell()
    const line = (await db.invoice_lines.where('invoice_id').equals(invoiceId).first())!
    await createReturn({
      invoiceId,
      lines: [{ invoiceLineId: line.id, qty: 2, disposition: 'restock' }],
    })
    renderApp(`/invoices/${invoiceId}/return`)
    expect(await screen.findByText(fill(ar.returns.returnedAlready, { n: 2 }))).toBeTruthy()
    const qty = screen.getByLabelText(new RegExp(ar.returns.qty))
    fireEvent.change(qty, { target: { value: '2' } })
    expect(screen.getByText(ar.returns.badQty)).toBeTruthy()
    fireEvent.change(qty, { target: { value: '1' } })
    expect(screen.getAllByText(/40\.00/, { selector: 'bdi' }).length).toBeGreaterThan(0)
  })

  it('says so when the invoice is cancelled', async () => {
    const { invoiceId } = await sell()
    await cancelInvoice(invoiceId, 'خطأ', false)
    renderApp(`/invoices/${invoiceId}/return`)
    expect(await screen.findByText(ar.returns.unavailable)).toBeTruthy()
  })
})

describe('customer profile and the invoice picker', () => {
  it('lists the invoices that can still be returned from and opens the return screen', async () => {
    const { invoiceId } = await sell()
    renderApp('/customers/c-1/return')
    const link = await screen.findByRole('link', { name: /INV-000001/ })
    fireEvent.click(link)
    await waitFor(() => expect(where()).toBe(`/invoices/${invoiceId}/return`))
  })

  it('says so when there is nothing to return from', async () => {
    renderApp('/customers/c-1/return')
    expect(await screen.findByText(ar.returns.noInvoicesAtAll)).toBeTruthy()
  })

  it('shows the returns under the customer, with the number and the invoice', async () => {
    const { invoiceId, number } = await sell()
    const line = (await db.invoice_lines.where('invoice_id').equals(invoiceId).first())!
    await createReturn({
      invoiceId,
      reason: 'كسر',
      lines: [{ invoiceLineId: line.id, qty: 1, disposition: 'restock' }],
    })
    renderApp('/customers/c-1')
    expect(await screen.findByText('RET-000001')).toBeTruthy()
    expect(
      screen.getByText(new RegExp(fill(ar.returns.fromInvoiceNumber, { number }))),
    ).toBeTruthy()
    expect(screen.getByText(ar.returns.unsent)).toBeTruthy()
    // 120.00 on the invoice, 20.00 paid, 40.00 credited: he owes 60.00
    expect(screen.getByText(/عليه.*60\.00/)).toBeTruthy()
  })
})

describe('Arabic digits from the iPad keyboard', () => {
  it('a quantity typed as ٢ is read as 2', async () => {
    const { invoiceId } = await sell()
    renderApp(`/invoices/${invoiceId}/return`)
    const qty = await screen.findByLabelText(new RegExp(ar.returns.qty))
    fireEvent.change(qty, { target: { value: '٢' } })
    expect(screen.queryByText(ar.returns.badQty)).toBeNull()
    expect(screen.getAllByText(/80\.00/, { selector: 'bdi' }).length).toBeGreaterThan(0)
    expect(
      (screen.getByRole('button', { name: ar.returns.confirm }) as HTMLButtonElement).disabled,
    ).toBe(false)
    fireEvent.change(qty, { target: { value: '٤' } })
    expect(screen.getByText(ar.returns.badQty)).toBeTruthy()
  })
})

describe('after confirming', () => {
  it('never flashes the quantity warning while the return is being saved', async () => {
    const { invoiceId } = await sell()
    renderApp(`/invoices/${invoiceId}/return`)
    fireEvent.change(await screen.findByLabelText(new RegExp(ar.returns.qty)), {
      target: { value: '3' },
    })
    fireEvent.click(screen.getByRole('button', { name: ar.returns.confirm }))
    const sheet = await screen.findByRole('dialog')
    let flashed = false
    const watch = new MutationObserver(() => {
      if (document.body.textContent?.includes(ar.returns.badQty)) flashed = true
    })
    watch.observe(document.body, { childList: true, subtree: true, characterData: true })
    fireEvent.click(within(sheet).getByRole('button', { name: ar.returns.confirm }))
    await waitFor(() => expect(where()).toBe(`/invoices/${invoiceId}`))
    watch.disconnect()
    expect(flashed).toBe(false)
  })
})
