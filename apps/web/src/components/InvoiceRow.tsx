import { memo } from 'react'
import { Link } from 'react-router'
import { ar } from '../i18n/ar'
import { formatDateTime } from '../lib/date'
import type { InvoiceItem } from '../lib/localSales'
import { formatMoney } from '../lib/money'
import { Tag } from './Tag'

/** The tags that say where an invoice stands: cancelled, delivered or not, sent or not. */
export function InvoiceTags({ invoice }: { invoice: InvoiceItem }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {invoice.status === 'cancelled' ? (
        <Tag kind="bad">{ar.invoices.cancelled}</Tag>
      ) : invoice.delivered ? (
        <Tag kind="good">{ar.invoices.delivered}</Tag>
      ) : (
        <Tag kind="plain">{ar.invoices.notDelivered}</Tag>
      )}
      {invoice.sendState === 'pending' && <Tag kind="wait">{ar.invoices.unsent}</Tag>}
      {invoice.sendState === 'rejected' && <Tag kind="bad">{ar.invoices.rejected}</Tag>}
    </span>
  )
}

export const InvoiceRow = memo(function InvoiceRow({
  invoice,
  showCustomer = true,
  to,
}: {
  invoice: InvoiceItem
  showCustomer?: boolean
  /** Where the row leads; the invoice itself by default. */
  to?: string
}) {
  return (
    <Link
      to={to ?? `/invoices/${invoice.id}`}
      className={`grid min-h-20 gap-2 rounded-xl bg-white p-3 md:grid-cols-[1fr_auto] md:items-center ${
        invoice.status === 'cancelled' ? 'opacity-70' : ''
      }`}
    >
      <span className="min-w-0">
        <span className="block font-bold">
          <bdi>{invoice.number}</bdi>
          {showCustomer && ` · ${invoice.customer_name}`}
        </span>
        <span className="block text-sm opacity-70">
          <bdi>{formatDateTime(invoice.issued_at)}</bdi>
        </span>
        <InvoiceTags invoice={invoice} />
      </span>
      <span className="grid gap-0.5 text-end">
        <bdi className="text-lg font-bold">{formatMoney(invoice.total)}</bdi>
        {invoice.status === 'confirmed' && (
          <span className="text-sm">
            {ar.invoices.paid}: <bdi>{formatMoney(invoice.paid)}</bdi> · {ar.invoices.remaining}:{' '}
            <bdi>{formatMoney(invoice.remaining)}</bdi>
          </span>
        )}
      </span>
    </Link>
  )
})
