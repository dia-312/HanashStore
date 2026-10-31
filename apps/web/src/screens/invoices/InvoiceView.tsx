import { Suspense, lazy, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ConfirmSheet } from '../../components/ConfirmSheet'
import { InvoiceTags } from '../../components/InvoiceRow'
import { ar, fill } from '../../i18n/ar'
import { formatDateTime } from '../../lib/date'
import { invoiceDocument } from '../../lib/documents'
import { buildInvoiceDetail, loadSalesSnapshot } from '../../lib/localSales'
import { loadSettings } from '../../lib/settings'
import { formatMoney } from '../../lib/money'
import { cancelInvoice, markDelivered } from '../../lib/sales'
import { useLive } from '../../lib/useLive'

// The pictures and the sharing code load only when this screen opens (SPEC section 17).
const SharePanel = lazy(() => import('../../documents/SharePanel'))

const button = 'min-h-12 rounded-xl border-2 border-navy/30 bg-white px-5 font-bold'

export default function InvoiceView() {
  const { invoiceId = '' } = useParams()
  // undefined while the device is read, null when it has no such invoice.
  const invoice = useLive(
    async () => buildInvoiceDetail(await loadSalesSnapshot(), invoiceId),
    [invoiceId],
  )
  const document = useLive(async () => {
    const [snapshot, settings] = await Promise.all([loadSalesSnapshot(), loadSettings()])
    return invoiceDocument(snapshot, invoiceId, settings)
  }, [invoiceId])
  const [cancelling, setCancelling] = useState(false)
  const [reason, setReason] = useState('')
  const [voidPayment, setVoidPayment] = useState<boolean | null>(null)

  if (invoice === undefined) return <p aria-busy="true">{ar.common.loading}</p>
  if (invoice === null) return <p className="text-lg font-bold">{ar.invoices.notFound}</p>

  const needsAnswer = invoice.hasActivePayment
  const ready = reason.trim() !== '' && (!needsAnswer || voidPayment !== null)
  const closeSheet = () => {
    setCancelling(false)
    setReason('')
    setVoidPayment(null)
  }

  return (
    <section className="grid max-w-4xl gap-4">
      <Link to="/invoices" className="inline-flex min-h-11 w-fit items-center font-bold underline">
        ← {ar.invoices.back}
      </Link>
      <div className="grid gap-3 rounded-2xl bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold">
              <bdi>{invoice.number}</bdi>
            </h2>
            <p>
              <Link to={`/customers/${invoice.customer_id}`} className="font-bold underline">
                {invoice.customer_name}
              </Link>
            </p>
            <p className="text-sm opacity-70">
              <bdi>{formatDateTime(invoice.issued_at)}</bdi>
            </p>
          </div>
          <InvoiceTags invoice={invoice} />
        </div>
        {invoice.sendState === 'pending' && <p className="text-sm">{ar.invoices.unsentHint}</p>}
        {invoice.sendState === 'rejected' && (
          <p role="alert" className="font-bold text-red-700">
            <span aria-hidden="true">⚠ </span>
            {fill(ar.invoices.rejectedHint, { code: invoice.rejectedCode ?? '' })}
          </p>
        )}
        {invoice.status === 'cancelled' && invoice.cancel_reason && (
          <p className="font-bold">
            {fill(ar.invoices.cancelledBecause, { reason: invoice.cancel_reason })}
          </p>
        )}
        {invoice.delivered_at && (
          <p className="text-sm">
            {fill(ar.invoices.deliveredAt, { time: formatDateTime(invoice.delivered_at) })}
          </p>
        )}
      </div>

      <div className="grid gap-2 rounded-2xl bg-white p-4">
        <h3 className="text-lg font-bold">{ar.invoices.lines}</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-96 text-start">
            <thead>
              <tr className="text-start text-sm">
                <th className="text-start">{ar.catalog.title}</th>
                <th className="text-start">{ar.invoices.qty}</th>
                <th className="text-start">{ar.invoices.price}</th>
                <th className="text-start">{ar.invoices.lineTotal}</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line) => (
                <tr key={line.id} className="border-t border-navy/10">
                  <td className="py-2">
                    {line.product_name}
                    {line.variant_label && (
                      <span className="block text-sm opacity-70">{line.variant_label}</span>
                    )}
                  </td>
                  <td>
                    <bdi>{line.qty}</bdi>
                  </td>
                  <td>
                    <bdi>{formatMoney(line.unit_price)}</bdi>
                  </td>
                  <td>
                    <bdi>{formatMoney(line.line_total)}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="grid gap-1 border-t border-navy/10 pt-2">
          {invoice.discount > 0 && (
            <>
              <div className="flex justify-between">
                <dt>{ar.invoices.subtotal}</dt>
                <dd>
                  <bdi>{formatMoney(invoice.subtotal)}</bdi>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt>{ar.invoices.discount}</dt>
                <dd>
                  <bdi>-{formatMoney(invoice.discount)}</bdi>
                </dd>
              </div>
            </>
          )}
          <div className="flex justify-between text-lg font-bold">
            <dt>{ar.invoices.total}</dt>
            <dd>
              <bdi>{formatMoney(invoice.total)}</bdi>
            </dd>
          </div>
          {invoice.status === 'confirmed' && (
            <>
              <div className="flex justify-between">
                <dt>{ar.invoices.paid}</dt>
                <dd>
                  <bdi>{formatMoney(invoice.paid)}</bdi>
                </dd>
              </div>
              <div className="flex justify-between font-bold">
                <dt>{ar.invoices.remaining}</dt>
                <dd>
                  <bdi>{formatMoney(invoice.remaining)}</bdi>
                </dd>
              </div>
            </>
          )}
        </dl>
        {invoice.note && <p className="text-sm">{invoice.note}</p>}
      </div>

      {invoice.payments.length > 0 && (
        <div className="grid gap-2 rounded-2xl bg-white p-4">
          <h3 className="text-lg font-bold">{ar.invoices.payments}</h3>
          <ul className="grid gap-1">
            {invoice.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap justify-between gap-2">
                <span>
                  <bdi>{p.number}</bdi> · {ar.invoices.method[p.method]}
                  {p.status === 'voided' && ` · ${ar.invoices.voided}`}
                  {p.note && <span className="block text-sm opacity-70">{p.note}</span>}
                </span>
                <bdi className="font-bold">{formatMoney(p.amount)}</bdi>
              </li>
            ))}
          </ul>
        </div>
      )}

      {document && (
        <Suspense fallback={<p>{ar.common.loading}</p>}>
          <SharePanel
            doc={{ type: 'invoice', data: document }}
            fileBase={invoice.number}
            // The server renders the PDF only for an invoice it has, with nothing waiting to change it.
            pdfPath={
              invoice.sendState === 'synced' && !invoice.cancelPending
                ? `/invoices/${invoice.id}/pdf`
                : null
            }
            pdfBlocked={ar.share.pdfNeedsServer}
          />
        </Suspense>
      )}

      {invoice.status === 'confirmed' && (
        <div className="flex flex-wrap gap-2">
          {!invoice.delivered && (
            <button type="button" className={button} onClick={() => void markDelivered(invoice.id)}>
              {ar.invoices.markDelivered}
            </button>
          )}
          {invoice.canCancel && (
            <button type="button" className={button} onClick={() => setCancelling(true)}>
              {ar.invoices.cancel}
            </button>
          )}
        </div>
      )}

      {cancelling && (
        <ConfirmSheet
          title={fill(ar.invoices.cancelTitle, { number: invoice.number })}
          message={ar.invoices.cancelHint}
          lines={[{ label: ar.invoices.total, value: formatMoney(invoice.total) }]}
          confirmLabel={ar.invoices.cancelConfirm}
          confirmDisabled={!ready}
          onCancel={closeSheet}
          onConfirm={async () => {
            await cancelInvoice(invoice.id, reason, voidPayment === true)
            closeSheet()
          }}
        >
          <label className="mb-3 grid gap-1">
            <span className="font-bold">{ar.invoices.cancelReason}</span>
            <input
              className="min-h-12 w-full rounded-xl border-2 border-navy/30 bg-white px-3"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {needsAnswer && (
            <fieldset className="mb-3 grid gap-2 rounded-xl bg-white p-3">
              <legend className="font-bold">
                {fill(ar.invoices.voidQuestion, { amount: formatMoney(invoice.paid) })}
              </legend>
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="radio"
                  name="void"
                  checked={voidPayment === true}
                  onChange={() => setVoidPayment(true)}
                  className="size-5"
                />
                {ar.invoices.voidYes}
              </label>
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="radio"
                  name="void"
                  checked={voidPayment === false}
                  onChange={() => setVoidPayment(false)}
                  className="size-5"
                />
                {ar.invoices.voidNo}
              </label>
            </fieldset>
          )}
        </ConfirmSheet>
      )}
    </section>
  )
}
