import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, setMeta, wipeLocalData, type DbCustomer } from '../db'
import { ar } from '../i18n/ar'
import { pendingCommands } from '../lib/sync/outbox'
import { CustomerProfile } from './customers/CustomerProfile'
import Refund from './customers/Refund'

// he paid 30.00 more than he owes: the shop owes him 30.00
const customer: DbCustomer = {
  id: 'c-1',
  name: 'أحمد',
  shop_name: null,
  phone: null,
  area: null,
  address: null,
  notes: null,
  opening_balance: -3000,
  search_text: 'احمد',
  is_active: true,
  balance: -3000,
  change_seq: 2,
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}

const renderApp = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="customers/:customerId/refund" element={<Refund />} />
        <Route path="customers/:customerId" element={<CustomerProfile />} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(async () => {
  await wipeLocalData()
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
  await setMeta('identity', { user: { id: 'u', name: 'Rep' }, device: { id: 'd1', name: 'iPad' } })
  await db.customers.put(customer)
})

afterEach(() => cleanup())

describe('refund screen', () => {
  it('offers the whole credit, shows the balance before and after, and queues the refund offline', async () => {
    renderApp('/customers/c-1/refund')
    const amount = (await screen.findByLabelText(ar.refund.amount)) as HTMLInputElement
    expect(amount.value).toBe('30')
    expect(screen.getByText(/له عندك الآن/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: ar.refund.confirm }))
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getAllByText(/30\.00/).length).toBeGreaterThan(0)
    fireEvent.click(within(sheet).getByRole('button', { name: ar.refund.confirm }))
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/customers/c-1'))
    const [command] = await pendingCommands()
    expect(command?.type).toBe('refund.create')
    expect(command?.payload).toMatchObject({
      customer_id: 'c-1',
      amount: 3000,
      method: 'cash',
      number: 'REF-000001',
    })
    // the profile shows it at once as a refund waiting to be sent, and the credit is gone
    expect(await screen.findByText(ar.refund.tag)).toBeTruthy()
    expect(screen.getByText(ar.payment.unsent)).toBeTruthy()
    expect(screen.getByText(new RegExp(ar.refund.standalone))).toBeTruthy()
    expect(screen.getAllByText('لا رصيد').length).toBeGreaterThan(0)
  })

  it('refuses zero, a bad amount and a cheque with no details; warns when he would owe', async () => {
    renderApp('/customers/c-1/refund')
    const amount = await screen.findByLabelText(ar.refund.amount)
    const confirm = screen.getByRole('button', { name: ar.refund.confirm }) as HTMLButtonElement
    fireEvent.change(amount, { target: { value: '0' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(amount, { target: { value: 'abc' } })
    expect(screen.getByText(ar.refund.badAmount)).toBeTruthy()
    fireEvent.change(amount, { target: { value: '‏50‎' } }) // marks the iPad can add
    expect(confirm.disabled).toBe(false)
    expect(screen.getByText(/أكبر من رصيده/)).toBeTruthy() // 50 against 30 of credit: he would owe 20
    fireEvent.click(screen.getByRole('button', { name: ar.invoices.method.cheque }))
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(ar.refund.chequeNote), {
      target: { value: 'شيك 7' },
    })
    expect(confirm.disabled).toBe(false)
  })

  it('says there is no credit when he owes, and still allows a refund', async () => {
    await db.customers.put({ ...customer, balance: 5000, opening_balance: 5000 })
    renderApp('/customers/c-1/refund')
    expect(await screen.findByText(ar.refund.noCredit)).toBeTruthy()
    const amount = screen.getByLabelText(ar.refund.amount) as HTMLInputElement
    expect(amount.value).toBe('')
  })
})
