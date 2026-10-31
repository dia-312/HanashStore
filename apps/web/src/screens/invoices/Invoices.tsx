import { useMemo, useState } from 'react'
import { InvoiceRow } from '../../components/InvoiceRow'
import { VirtualRows } from '../../components/VirtualRows'
import { ar } from '../../i18n/ar'
import { buildInvoiceList, loadSalesSnapshot, type InvoiceFilter } from '../../lib/localSales'
import { useLive } from '../../lib/useLive'

const select = 'min-h-12 rounded-xl border-2 border-navy/30 bg-white px-3'

/** Invoices on this device (the last 12 months), newest first. */
export default function Invoices() {
  const snapshot = useLive(loadSalesSnapshot, [])
  const [customerId, setCustomerId] = useState('')
  const [delivery, setDelivery] = useState<'' | 'yes' | 'no'>('')
  const [status, setStatus] = useState<'' | 'confirmed' | 'cancelled'>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const items = useMemo(() => {
    if (!snapshot) return []
    const filter: InvoiceFilter = {
      customerId: customerId || undefined,
      delivered: delivery === '' ? undefined : delivery === 'yes',
      status: status || undefined,
      from: from || undefined,
      to: to || undefined,
    }
    return buildInvoiceList(snapshot, filter)
  }, [snapshot, customerId, delivery, status, from, to])

  return (
    <section className="flex h-full flex-col gap-3">
      <h2 className="text-2xl font-bold">{ar.invoices.title}</h2>
      <div className="flex flex-wrap items-end gap-3">
        <select
          aria-label={ar.invoices.customer}
          className={select}
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
        >
          <option value="">{ar.invoices.anyCustomer}</option>
          {snapshot?.customers
            .toSorted((a, b) => a.name.localeCompare(b.name, 'ar'))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <select
          aria-label={ar.invoices.deliveryAll}
          className={select}
          value={delivery}
          onChange={(e) => setDelivery(e.target.value as '' | 'yes' | 'no')}
        >
          <option value="">{ar.invoices.deliveryAll}</option>
          <option value="yes">{ar.invoices.delivered}</option>
          <option value="no">{ar.invoices.notDelivered}</option>
        </select>
        <select
          aria-label={ar.invoices.statusAll}
          className={select}
          value={status}
          onChange={(e) => setStatus(e.target.value as '' | 'confirmed' | 'cancelled')}
        >
          <option value="">{ar.invoices.statusAll}</option>
          <option value="confirmed">{ar.invoices.confirmed}</option>
          <option value="cancelled">{ar.invoices.cancelled}</option>
        </select>
        <label className="grid gap-1 text-sm font-bold">
          {ar.invoices.from}
          <input
            type="date"
            dir="ltr"
            className={select}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm font-bold">
          {ar.invoices.to}
          <input
            type="date"
            dir="ltr"
            className={select}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>
      {snapshot === undefined ? (
        <div aria-busy="true" className="grid gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-navy/10" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-lg">{ar.invoices.empty}</p>
      ) : (
        <VirtualRows
          items={items}
          estimate={120}
          keyOf={(i) => i.id}
          render={(i) => <InvoiceRow invoice={i} />}
        />
      )}
    </section>
  )
}
