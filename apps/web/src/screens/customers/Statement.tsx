import { Suspense, lazy, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ar } from '../../i18n/ar'
import { dayToDisplay, hebronDay } from '../../lib/date'
import { LABELS, defaultPeriod, statementDocument } from '../../lib/documents'
import { loadSalesSnapshot } from '../../lib/localSales'
import { loadSettings } from '../../lib/settings'
import { useLive } from '../../lib/useLive'

// The pictures and the sharing code load only when this screen opens (SPEC section 17).
const SharePanel = lazy(() => import('../../documents/SharePanel'))

const field = 'min-h-12 rounded-xl border-2 border-navy/30 bg-white px-3'
const TALL_ROWS = 40

export default function Statement() {
  const { customerId = '' } = useParams()
  const today = useMemo(() => hebronDay(new Date().toISOString()), [])
  const start = useMemo(() => defaultPeriod(today), [today])
  const [from, setFrom] = useState(start.from)
  const [to, setTo] = useState(start.to)
  const [showOff, setShowOff] = useState(false)

  const data = useLive(async () => {
    const [snapshot, settings] = await Promise.all([loadSalesSnapshot(), loadSettings()])
    const customer = snapshot.customers.find((c) => c.id === customerId)
    // The server only knows what it has received: anything still waiting on this device for him
    // (his own record, or a sale or cancellation) would be missing from its PDF.
    const waiting = snapshot.outbox.some((command) => {
      if (command.status !== 'pending') return false
      const payload = command.payload as { customer_id?: string }
      return payload.customer_id === customerId
    })
    return { snapshot, settings, customer, waiting }
  }, [customerId])

  const valid = from !== '' && to !== '' && from <= to
  const doc = useMemo(
    () =>
      data && valid
        ? statementDocument(data.snapshot, customerId, from, to, showOff, data.settings)
        : null,
    [data, valid, customerId, from, to, showOff],
  )

  if (data === undefined) return <p aria-busy="true">{ar.common.loading}</p>
  if (!data.customer) return <p className="text-lg font-bold">{ar.customers.notFound}</p>

  const customer = data.customer
  const serverKnows = customer.change_seq > 0 && !data.waiting
  const query = new URLSearchParams({ from, to, include_cancelled: String(showOff) })
  const oldest = data.snapshot.invoices.reduce(
    (min, i) => (hebronDay(i.issued_at) < min ? hebronDay(i.issued_at) : min),
    '9999-99-99',
  )

  return (
    <section className="grid max-w-4xl gap-4">
      <Link
        to={`/customers/${customer.id}`}
        className="inline-flex min-h-11 w-fit items-center font-bold underline"
      >
        ← {ar.statement.back}
      </Link>
      <h2 className="text-2xl font-bold">
        {ar.statement.title} · {customer.name}
      </h2>

      <div className="flex flex-wrap items-end gap-3 rounded-2xl bg-white p-4">
        <label className="grid gap-1 text-sm font-bold">
          {ar.statement.from}
          <input
            type="date"
            dir="ltr"
            className={field}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm font-bold">
          {ar.statement.to}
          <input
            type="date"
            dir="ltr"
            className={field}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label className="flex min-h-12 items-center gap-2 font-bold">
          <input
            type="checkbox"
            checked={showOff}
            onChange={(e) => setShowOff(e.target.checked)}
            className="size-5"
          />
          {ar.statement.showOff}
        </label>
      </div>

      {valid && oldest !== '9999-99-99' && from < oldest && (
        <p role="status" className="text-sm font-bold">
          <span aria-hidden="true">ⓘ </span>
          {ar.statement.olderThanDevice}
        </p>
      )}

      {doc && (
        <>
          <div className="overflow-x-auto rounded-2xl bg-white p-4">
            <table className="w-full min-w-120 text-start">
              <thead>
                <tr className="text-start text-sm">
                  <th className="text-start">{LABELS.statement.date}</th>
                  <th className="text-start">{LABELS.statement.doc}</th>
                  <th className="text-start">{ar.statement.debit}</th>
                  <th className="text-start">{ar.statement.credit}</th>
                  <th className="text-start">{ar.statement.balance}</th>
                </tr>
              </thead>
              <tbody>
                {doc.rows.map((r, i) => (
                  <tr
                    key={i}
                    className={`border-t border-navy/10 ${r.css === 'off' ? 'line-through opacity-60' : ''} ${
                      r.css === 'opening' ? 'font-bold' : ''
                    }`}
                  >
                    <td className="py-2">
                      <bdi>{r.date}</bdi>
                    </td>
                    <td>
                      {r.label}
                      {r.number && (
                        <>
                          {' '}
                          <bdi>{r.number}</bdi>
                        </>
                      )}
                    </td>
                    <td>{r.debit && <bdi>{r.debit}</bdi>}</td>
                    <td>{r.credit && <bdi>{r.credit}</bdi>}</td>
                    <td>
                      <bdi>{r.balance}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {doc.rows.length === 1 && <p className="mt-2 opacity-70">{ar.statement.empty}</p>}
            <p className="mt-3 flex justify-between text-lg font-bold">
              <span>{ar.statement.closing}</span>
              <bdi>{doc.totals.closing}</bdi>
            </p>
          </div>

          <Suspense fallback={<p>{ar.common.loading}</p>}>
            <SharePanel
              doc={{ type: 'statement', data: doc }}
              fileBase={`statement-${from}-${to}`}
              pdfPath={serverKnows ? `/customers/${customer.id}/statement.pdf?${query}` : null}
              pdfBlocked={ar.share.pdfNeedsServer}
              tall={doc.rows.length > TALL_ROWS}
            />
          </Suspense>
          <p className="text-sm opacity-70">
            {dayToDisplay(from)} – {dayToDisplay(to)}
          </p>
        </>
      )}
    </section>
  )
}
