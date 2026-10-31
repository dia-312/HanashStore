import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { Balance } from '../../components/Balance'
import { ConfirmSheet } from '../../components/ConfirmSheet'
import { InvoiceRow } from '../../components/InvoiceRow'
import { Tag } from '../../components/Tag'
import { ar, fill } from '../../i18n/ar'
import { formatDateTime } from '../../lib/date'
import { buildCustomerProfile, loadSalesSnapshot } from '../../lib/localSales'
import { telUrl, whatsappUrl } from '../../lib/phone'
import { saveCustomer } from '../../lib/sales'
import { useLive } from '../../lib/useLive'

const action =
  'inline-flex min-h-12 items-center rounded-xl border-2 border-navy/30 bg-white px-5 font-bold'

export function CustomerProfile() {
  const { customerId = '' } = useParams()
  // undefined while the device is read, null when it has no such customer.
  const customer = useLive(
    async () => buildCustomerProfile(await loadSalesSnapshot(), customerId),
    [customerId],
  )
  const [stopping, setStopping] = useState(false)

  if (customer === undefined) return <p aria-busy="true">{ar.common.loading}</p>
  if (customer === null) return <p className="text-lg font-bold">{ar.customers.notFound}</p>

  const setActive = async (active: boolean) => {
    await saveCustomer({
      id: customer.id,
      name: customer.name,
      shopName: customer.shop_name ?? '',
      phone: customer.phone ?? '',
      area: customer.area ?? '',
      address: customer.address ?? '',
      notes: customer.notes ?? '',
      openingBalance: customer.opening_balance,
      isActive: active,
    })
    setStopping(false)
  }

  return (
    <section className="grid max-w-4xl gap-4">
      <Link to="/customers" className="inline-flex min-h-11 w-fit items-center font-bold underline">
        ← {ar.customers.back}
      </Link>
      <div className="grid gap-3 rounded-2xl bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold">
              {customer.name}
              {!customer.is_active && (
                <span className="ms-2 text-base">({ar.customers.stopped})</span>
              )}
            </h2>
            {customer.shop_name && <p className="text-lg">{customer.shop_name}</p>}
            <p className="text-sm opacity-70">
              {[customer.area, customer.address].filter(Boolean).join(' · ')}
            </p>
            {customer.phone && (
              <p>
                <bdi>{customer.phone}</bdi>
              </p>
            )}
            {customer.notes && <p className="mt-1 text-sm">{customer.notes}</p>}
            {customer.unsent && <Tag kind="wait">{ar.customers.unsent}</Tag>}
          </div>
          <div className="text-end">
            <div className="text-sm font-bold">{ar.customers.balance}</div>
            <Balance agorot={customer.balance} big />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {customer.is_active && (
            <Link
              to={`/present/${customer.id}`}
              className="inline-flex min-h-12 items-center rounded-xl bg-navy px-6 font-bold text-white"
            >
              {ar.customers.present}
            </Link>
          )}
          {customer.phone && (
            <>
              <a href={telUrl(customer.phone)} className={action}>
                ☎ {ar.customers.call}
              </a>
              <a
                href={whatsappUrl(customer.phone)}
                className={action}
                target="_blank"
                rel="noreferrer"
              >
                ✉ {ar.customers.whatsapp}
              </a>
            </>
          )}
          <Link to={`/customers/${customer.id}/statement`} className={action}>
            {ar.statement.open}
          </Link>
          <Link to={`/customers/${customer.id}/edit`} className={action}>
            {ar.customers.edit}
          </Link>
          <button
            type="button"
            className={action}
            onClick={() => (customer.is_active ? setStopping(true) : void setActive(true))}
          >
            {customer.is_active ? ar.customers.deactivate : ar.customers.activate}
          </button>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-lg font-bold">{ar.customers.invoices}</h3>
        <p className="mb-2 text-sm opacity-70">
          {customer.last_invoice_at
            ? fill(ar.customers.lastInvoice, { date: formatDateTime(customer.last_invoice_at) })
            : ar.customers.noInvoiceYet}
        </p>
        {customer.invoices.length === 0 ? (
          <p className="opacity-70">{ar.customers.noInvoices}</p>
        ) : (
          <ul className="grid gap-2">
            {customer.invoices.map((invoice) => (
              <li key={invoice.id}>
                <InvoiceRow invoice={invoice} showCustomer={false} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {stopping && (
        <ConfirmSheet
          title={ar.customers.deactivate}
          message={fill(ar.customers.deactivateConfirm, { name: customer.name })}
          confirmLabel={ar.customers.deactivate}
          onCancel={() => setStopping(false)}
          onConfirm={() => void setActive(false)}
        />
      )}
    </section>
  )
}
