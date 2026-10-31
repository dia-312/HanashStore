import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, setMeta, wipeLocalData, type DbCustomer, type DbVariant } from '../db'
import { ar } from '../i18n/ar'
import { getCart, setLineQty } from '../lib/cart'
import { confirmSale } from '../lib/sales'
import { pendingCommands } from '../lib/sync/outbox'
import Checkout from './checkout/Checkout'
import { EditCustomer, NewCustomer } from './customers/CustomerForm'
import { CustomerProfile } from './customers/CustomerProfile'
import { Customers } from './customers/Customers'
import InvoiceView from './invoices/InvoiceView'
import Invoices from './invoices/Invoices'

// jsdom has no layout, so the real virtualizer would show no rows; this stand-in lists every row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 100,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 100 })),
    measureElement: () => undefined,
  }),
}))

const customer = (id: string, name: string, extra: Partial<DbCustomer> = {}): DbCustomer => ({
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
  change_seq: 2,
  ...extra,
})

const variant = (id: string, extra: Partial<DbVariant> = {}): DbVariant => ({
  id,
  product_id: 'p1',
  sku: `SKU-${id}`,
  color: id === 'v1' ? 'أسود' : 'أحمر',
  size: null,
  price: 4500,
  min_stock: 1,
  stock_qty: 10,
  is_active: true,
  change_seq: 1,
  ...extra,
})

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}

const renderApp = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="customers" element={<Customers />} />
        <Route path="customers/new" element={<NewCustomer />} />
        <Route path="customers/:customerId" element={<CustomerProfile />} />
        <Route path="customers/:customerId/edit" element={<EditCustomer />} />
        <Route path="checkout/:customerId?" element={<Checkout />} />
        <Route path="invoices" element={<Invoices />} />
        <Route path="invoices/:invoiceId" element={<InvoiceView />} />
        <Route path="present/:customerId" element={<p>صفحة العرض</p>} />
        <Route path="catalog" element={<p>صفحة الكتالوج</p>} />
      </Routes>
    </MemoryRouter>,
  )

const where = () => screen.getByTestId('where').textContent

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
  await db.variants.bulkPut([variant('v1'), variant('v2', { stock_qty: 4, price: 2000 })])
  await db.customers.bulkPut([
    customer('c-1', 'أحمد', {
      shop_name: 'بقالة الأمل',
      area: 'نابلس',
      phone: '0599123456',
      balance: 15000,
      opening_balance: 15000,
    }),
    customer('c-2', 'بلال', { balance: -2000 }),
    customer('c-3', 'تامر', { balance: 500 }),
  ])
})

afterEach(() => cleanup())

describe('customers list', () => {
  it('shows every customer with his balance in words and a shape, and searches', async () => {
    renderApp('/customers')
    expect(await screen.findByText('أحمد')).toBeTruthy()
    expect(screen.getByText(/عليه.*150\.00/)).toBeTruthy()
    expect(screen.getByText(/له.*20\.00/)).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'بلال' } })
    await waitFor(() => expect(screen.queryByText('أحمد')).toBeNull())
    expect(screen.getByText('بلال')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'لا أحد' } })
    expect(await screen.findByText(ar.customers.noResults)).toBeTruthy()
  })

  it('sorts by balance, the biggest debt first', async () => {
    renderApp('/customers')
    await screen.findByText('أحمد')
    fireEvent.click(screen.getByRole('button', { name: ar.customers.sort.balance }))
    await waitFor(() => {
      const names = screen.getAllByRole('link').map((a) => a.textContent ?? '')
      expect(names.findIndex((t) => t.includes('أحمد'))).toBeLessThan(
        names.findIndex((t) => t.includes('تامر')),
      )
    })
  })

  it('says so when there are no customers, with a way to add one', async () => {
    await db.customers.clear()
    renderApp('/customers')
    expect(await screen.findByText(ar.empty.customers.title)).toBeTruthy()
    expect(screen.getByRole('link', { name: ar.empty.customers.next }).getAttribute('href')).toBe(
      '/customers/new',
    )
  })

  it('shows what is waiting: a sale not yet sent changes the balance and is marked', async () => {
    await db.variants.update('v1', { stock_qty: 10 })
    await confirmSale({
      customerId: 'c-3',
      lines: [{ variantId: 'v1', qty: 1 }],
      discount: 0,
      paid: 0,
      method: 'cash',
    })
    renderApp('/customers')
    expect(await screen.findByText('عليه ₪ 50.00')).toBeTruthy() // 5.00 + 45.00
  })
})

describe('adding and editing a customer', () => {
  it('adds one offline with an opening balance, saved on the device and queued', async () => {
    renderApp('/customers/new')
    fireEvent.change(await screen.findByLabelText(ar.customers.name), { target: { value: 'سامي' } })
    fireEvent.change(screen.getByLabelText(ar.customers.phone), { target: { value: '0599000111' } })
    fireEvent.change(screen.getByLabelText(ar.customers.openingBalance), {
      target: { value: '250.50' },
    })
    fireEvent.click(screen.getByRole('button', { name: ar.customers.create }))
    await waitFor(() => expect(where()).toMatch(/^\/customers\/[0-9a-f-]+$/))
    expect(await screen.findByText(/عليه.*250\.50/)).toBeTruthy()
    const row = (await db.customers.toArray()).find((c) => c.name === 'سامي')
    expect(row).toMatchObject({ opening_balance: 25050, balance: 25050, change_seq: 0 })
    expect((await pendingCommands())[0]?.type).toBe('customer.upsert')
  })

  it('needs a name, and refuses a bad opening balance', async () => {
    renderApp('/customers/new')
    fireEvent.click(await screen.findByRole('button', { name: ar.customers.create }))
    expect(await screen.findByText(ar.customers.nameRequired)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(ar.customers.name), { target: { value: 'سامي' } })
    fireEvent.change(screen.getByLabelText(ar.customers.openingBalance), {
      target: { value: 'abc' },
    })
    fireEvent.click(screen.getByRole('button', { name: ar.customers.create }))
    expect(await screen.findByText(ar.form.badPrice)).toBeTruthy()
    expect(await db.customers.count()).toBe(3)
  })

  it('editing shows the opening balance as fixed text and never lets it change', async () => {
    renderApp('/customers/c-1/edit')
    expect(await screen.findByDisplayValue('أحمد')).toBeTruthy()
    expect(screen.queryByLabelText(ar.customers.openingBalance)).toBeNull()
    fireEvent.change(screen.getByLabelText(ar.customers.name), { target: { value: 'أحمد علي' } })
    fireEvent.click(screen.getByRole('button', { name: ar.customers.save }))
    await waitFor(() => expect(where()).toBe('/customers/c-1'))
    expect(await db.customers.get('c-1')).toMatchObject({
      name: 'أحمد علي',
      opening_balance: 15000,
    })
  })
})

describe('customer profile', () => {
  it('shows the big balance, call and WhatsApp links, and starts a sale', async () => {
    renderApp('/customers/c-1')
    expect(await screen.findByRole('heading', { name: 'أحمد' })).toBeTruthy()
    expect(screen.getByText(/عليه.*150\.00/)).toBeTruthy()
    expect(
      screen.getByRole('link', { name: new RegExp(ar.customers.call) }).getAttribute('href'),
    ).toBe('tel:0599123456')
    expect(
      screen.getByRole('link', { name: new RegExp(ar.customers.whatsapp) }).getAttribute('href'),
    ).toBe('https://wa.me/970599123456')
    expect(screen.getByRole('link', { name: ar.customers.present }).getAttribute('href')).toBe(
      '/present/c-1',
    )
  })

  it('lists his invoices, newest first, with paid and remaining', async () => {
    const { invoiceId } = await confirmSale({
      customerId: 'c-1',
      lines: [{ variantId: 'v1', qty: 2 }],
      discount: 0,
      paid: 3000,
      method: 'cash',
    })
    renderApp('/customers/c-1')
    expect(await screen.findByText(/INV-000001/)).toBeTruthy()
    expect(screen.getByText(ar.invoices.unsent)).toBeTruthy()
    expect(screen.getByRole('link', { name: /INV-000001/ }).getAttribute('href')).toBe(
      `/invoices/${invoiceId}`,
    )
  })

  it('stopping a customer asks first, keeps his history and queues the change', async () => {
    renderApp('/customers/c-1')
    fireEvent.click(await screen.findByRole('button', { name: ar.customers.deactivate }))
    const sheet = await screen.findByRole('dialog')
    fireEvent.click(within(sheet).getByRole('button', { name: ar.customers.deactivate }))
    await waitFor(async () => expect((await db.customers.get('c-1'))?.is_active).toBe(false))
    expect(await screen.findByRole('button', { name: ar.customers.activate })).toBeTruthy()
    expect(screen.queryByRole('link', { name: ar.customers.present })).toBeNull() // no sale for a stopped customer
  })

  it('an unknown customer says so', async () => {
    renderApp('/customers/nope')
    expect(await screen.findByText(ar.customers.notFound)).toBeTruthy()
  })
})

describe('checkout', () => {
  const fillCart = async (customerId: string | null = 'c-1') => {
    await setLineQty(customerId, 'v1', 2) // 90.00
    await setLineQty(customerId, 'v2', 1) // 20.00
  }

  it('shows the lines and the customer balance, and the confirm button waits for the amount paid', async () => {
    await fillCart()
    renderApp('/checkout/c-1')
    expect(await screen.findByText('أحمد')).toBeTruthy()
    expect(screen.getAllByText(/110\.00/).length).toBeGreaterThan(0)
    const confirm = screen.getByRole('button', { name: ar.checkout.confirm }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(ar.checkout.paidNow), { target: { value: '0' } })
    await waitFor(() => expect(confirm.disabled).toBe(false)) // zero is allowed
  })

  it('works out the summary: total, paid, remaining and the balance after', async () => {
    await fillCart()
    renderApp('/checkout/c-1')
    fireEvent.change(await screen.findByLabelText(ar.checkout.discount), {
      target: { value: '10' },
    })
    fireEvent.change(screen.getByLabelText(ar.checkout.paidNow), { target: { value: '40' } })
    const summary = (await screen.findByText(ar.checkout.summary)).closest('div')!
    await waitFor(() => {
      expect(within(summary).getByText(ar.checkout.total).nextSibling?.textContent).toContain(
        '100.00',
      )
      expect(within(summary).getByText(ar.checkout.remaining).nextSibling?.textContent).toContain(
        '60.00',
      )
    })
    expect(within(summary).getByText(ar.checkout.balanceAfter).nextSibling?.textContent).toMatch(
      /210\.00/,
    ) // 150 + 100 - 40
  })

  it('refuses a discount larger than the invoice', async () => {
    await fillCart()
    renderApp('/checkout/c-1')
    fireEvent.change(await screen.findByLabelText(ar.checkout.discount), {
      target: { value: '500' },
    })
    fireEvent.change(screen.getByLabelText(ar.checkout.paidNow), { target: { value: '0' } })
    expect(await screen.findByText(ar.checkout.badDiscount)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: ar.checkout.confirm }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('warns when the payment leaves the customer in credit, and still allows it', async () => {
    await fillCart()
    renderApp('/checkout/c-3')
    expect(await screen.findByText(ar.checkout.emptyCart)).toBeTruthy() // c-3 has no cart
    cleanup()
    await fillCart('c-3')
    renderApp('/checkout/c-3')
    fireEvent.change(await screen.findByLabelText(ar.checkout.paidNow), {
      target: { value: '1000' },
    })
    expect(await screen.findByText(/رصيد دائن/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: ar.checkout.confirm }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('a cheque needs its details in the note', async () => {
    await fillCart()
    renderApp('/checkout/c-1')
    fireEvent.change(await screen.findByLabelText(ar.checkout.paidNow), { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: ar.invoices.method.cheque }))
    const confirm = screen.getByRole('button', { name: ar.checkout.confirm }) as HTMLButtonElement
    await waitFor(() => expect(confirm.disabled).toBe(true))
    fireEvent.change(screen.getByLabelText(ar.checkout.chequeNote), {
      target: { value: '123 بنك فلسطين' },
    })
    await waitFor(() => expect(confirm.disabled).toBe(false))
  })

  it('blocks the sale when the shelf no longer holds what is in the cart', async () => {
    await fillCart()
    await db.variants.update('v2', { stock_qty: 0 })
    renderApp('/checkout/c-1')
    fireEvent.change(await screen.findByLabelText(ar.checkout.paidNow), { target: { value: '0' } })
    expect(await screen.findByText(/المتوفر من "أرجيلة كبيرة" هو 0 فقط/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: ar.checkout.confirm }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('confirming shows the numbers first, then saves the invoice offline and opens it', async () => {
    await fillCart()
    renderApp('/checkout/c-1')
    fireEvent.change(await screen.findByLabelText(ar.checkout.paidNow), { target: { value: '40' } })
    fireEvent.click(screen.getByRole('button', { name: ar.checkout.confirm }))
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByText(/110\.00/)).toBeTruthy()
    expect(within(sheet).getByText(/40\.00/)).toBeTruthy()
    fireEvent.click(within(sheet).getByRole('button', { name: ar.checkout.confirm }))
    await waitFor(() => expect(where()).toMatch(/^\/invoices\/[0-9a-f-]+$/))
    expect(await screen.findByText('INV-000001')).toBeTruthy()
    const [command] = await pendingCommands()
    expect(command?.type).toBe('invoice.create')
    expect(await getCart('c-1')).toBeUndefined()
    expect(await db.invoices.count()).toBe(1)
  })

  it('a sale with no customer asks for one at checkout and moves the cart to him', async () => {
    await fillCart(null)
    renderApp('/checkout')
    fireEvent.change(await screen.findByLabelText(ar.customers.search), {
      target: { value: 'بلال' },
    })
    fireEvent.click(await screen.findByRole('button', { name: /بلال/ }))
    await waitFor(() => expect(where()).toBe('/checkout/c-2'))
    expect(await screen.findByLabelText(ar.checkout.paidNow)).toBeTruthy()
    expect((await getCart('c-2'))?.lines).toHaveLength(2)
    expect(await getCart(null)).toBeUndefined()
  })
})

describe('invoice screen', () => {
  const sell = (paid: number) =>
    confirmSale({
      customerId: 'c-1',
      lines: [
        { variantId: 'v1', qty: 2 },
        { variantId: 'v2', qty: 1 },
      ],
      discount: 1000,
      paid,
      method: 'transfer',
    })

  it('shows the lines, the discount, paid and remaining, and the payment', async () => {
    const { invoiceId } = await sell(3000)
    renderApp(`/invoices/${invoiceId}`)
    expect(await screen.findByRole('heading', { name: 'INV-000001' })).toBeTruthy()
    expect(screen.getAllByText('أرجيلة كبيرة').length).toBe(2)
    expect(screen.getByText(/-.*10\.00/)).toBeTruthy()
    expect(screen.getByText(ar.invoices.remaining).nextSibling?.textContent).toContain('70.00')
    expect(screen.getByText(/REC-000001/)).toBeTruthy()
    expect(screen.getByText(ar.invoices.unsentHint)).toBeTruthy()
  })

  it('marks delivered, once', async () => {
    const { invoiceId } = await sell(0)
    renderApp(`/invoices/${invoiceId}`)
    fireEvent.click(await screen.findByRole('button', { name: ar.invoices.markDelivered }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: ar.invoices.markDelivered })).toBeNull(),
    )
    expect(screen.getAllByText(ar.invoices.delivered).length).toBeGreaterThan(0)
    expect((await pendingCommands()).map((c) => c.type)).toContain('invoice.mark_delivered')
  })

  it('cancelling needs a reason and, with a payment, an answer about the money', async () => {
    const { invoiceId } = await sell(3000)
    renderApp(`/invoices/${invoiceId}`)
    fireEvent.click(await screen.findByRole('button', { name: ar.invoices.cancel }))
    const sheet = await screen.findByRole('dialog')
    const confirm = within(sheet).getByRole('button', {
      name: ar.invoices.cancelConfirm,
    }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(within(sheet).getByLabelText(ar.invoices.cancelReason), {
      target: { value: 'خطأ' },
    })
    expect(confirm.disabled).toBe(true) // still no answer about the payment
    expect(within(sheet).getByText(/دفع الزبون.*30\.00/)).toBeTruthy()
    fireEvent.click(within(sheet).getByLabelText(ar.invoices.voidYes))
    await waitFor(() => expect(confirm.disabled).toBe(false))
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(screen.getAllByText(ar.invoices.cancelled).length).toBeGreaterThan(0),
    )
    const cancel = (await pendingCommands()).find((c) => c.type === 'invoice.cancel')
    expect(cancel?.payload).toMatchObject({
      reason: 'خطأ',
      void_payment: true,
      total: 10000,
    })
    expect(screen.queryByRole('button', { name: ar.invoices.cancel })).toBeNull()
  })

  it('an invoice with no payment cancels without that question', async () => {
    const { invoiceId } = await sell(0)
    renderApp(`/invoices/${invoiceId}`)
    fireEvent.click(await screen.findByRole('button', { name: ar.invoices.cancel }))
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).queryByRole('radio')).toBeNull()
    fireEvent.change(within(sheet).getByLabelText(ar.invoices.cancelReason), {
      target: { value: 'خطأ' },
    })
    await waitFor(() =>
      expect(
        (
          within(sheet).getByRole('button', {
            name: ar.invoices.cancelConfirm,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    )
  })

  it('a missing invoice says so', async () => {
    renderApp('/invoices/nope')
    expect(await screen.findByText(ar.invoices.notFound)).toBeTruthy()
  })
})

describe('invoices list', () => {
  it('lists invoices newest first and filters by customer, delivery and status', async () => {
    const a = await confirmSale({
      customerId: 'c-1',
      lines: [{ variantId: 'v1', qty: 1 }],
      discount: 0,
      paid: 0,
      method: 'cash',
    })
    await confirmSale({
      customerId: 'c-2',
      lines: [{ variantId: 'v2', qty: 1 }],
      discount: 0,
      paid: 0,
      method: 'cash',
    })
    renderApp('/invoices')
    expect(await screen.findByText(/INV-000002/)).toBeTruthy()
    expect(screen.getByText(/INV-000001/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(ar.invoices.customer), { target: { value: 'c-2' } })
    await waitFor(() => expect(screen.queryByText(/INV-000001/)).toBeNull())
    fireEvent.change(screen.getByLabelText(ar.invoices.customer), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText(ar.invoices.deliveryAll), { target: { value: 'yes' } })
    expect(await screen.findByText(ar.invoices.empty)).toBeTruthy()
    expect(a.invoiceId).toBeTruthy()
  })
})
