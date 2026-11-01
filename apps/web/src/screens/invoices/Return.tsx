import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Balance } from '../../components/Balance'
import { ConfirmSheet } from '../../components/ConfirmSheet'
import { ar, fill } from '../../i18n/ar'
import { returnLineAmount } from '../../lib/billing'
import {
  buildInvoiceDetail,
  effectiveBalances,
  loadSalesSnapshot,
  returnableLines,
} from '../../lib/localSales'
import { formatMoney, parseCount } from '../../lib/money'
import { createReturn, SaleError } from '../../lib/sales'
import type { Disposition } from '../../lib/sync/commands'
import { useLive } from '../../lib/useLive'

const input = 'min-h-12 rounded-xl border-2 border-navy/30 bg-white px-3 text-lg'

interface Pick {
  qty: string
  disposition: Disposition
}

/** Goods coming back from one invoice (SPEC F11): the rep picks, per line, how many and whether
 * they go back on the shelf or are written off; the credit is shown before confirming. Works
 * offline. */
export default function Return() {
  const { invoiceId = '' } = useParams()
  const navigate = useNavigate()
  const data = useLive(async () => {
    const snapshot = await loadSalesSnapshot()
    const invoice = buildInvoiceDetail(snapshot, invoiceId)
    if (!invoice) return null
    return {
      invoice,
      lines: returnableLines(snapshot, invoiceId),
      balance: effectiveBalances(snapshot).get(invoice.customer_id) ?? 0,
    }
  }, [invoiceId])
  const [picks, setPicks] = useState<Record<string, Pick>>({})
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (data === undefined) return <p aria-busy="true">{ar.common.loading}</p>
  if (data === null) return <p className="text-lg font-bold">{ar.invoices.notFound}</p>
  const { invoice, lines, balance } = data

  const pickOf = (id: string): Pick => picks[id] ?? { qty: '', disposition: 'restock' }
  const set = (id: string, change: Partial<Pick>) =>
    setPicks((p) => ({ ...p, [id]: { ...pickOf(id), ...change } }))

  const rows = lines.map((entry) => {
    const pick = pickOf(entry.line.id)
    const parsed = pick.qty.trim() === '' ? 0 : parseCount(pick.qty)
    const qty = parsed ?? 0
    const valid = parsed !== null && qty <= entry.remaining
    const amount =
      valid && qty > 0
        ? returnLineAmount(
            entry.line.line_total,
            entry.line.discount_share,
            entry.line.qty,
            entry.returned,
            entry.creditedSoFar,
            qty,
          )
        : 0
    return { entry, pick, qty: valid ? qty : 0, valid, amount }
  })
  const chosen = rows.filter((r) => r.qty > 0)
  const total = chosen.reduce((sum, r) => sum + r.amount, 0)
  const allValid = rows.every((r) => r.valid)
  const ready = allValid && chosen.length > 0
  const after = balance - total

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await createReturn({
        invoiceId: invoice.id,
        reason,
        lines: chosen.map((r) => ({
          invoiceLineId: r.entry.line.id,
          qty: r.qty,
          disposition: r.pick.disposition,
        })),
      })
      void navigate(`/invoices/${invoice.id}`, { replace: true })
    } catch (e) {
      setError(
        e instanceof SaleError && e.code === 'BAD_RETURN_QTY'
          ? ar.returns.badQty
          : ar.returns.failed,
      )
      setBusy(false)
    }
  }

  return (
    <section className="grid max-w-3xl gap-4">
      <Link
        to={`/invoices/${invoice.id}`}
        className="inline-flex min-h-11 w-fit items-center font-bold underline"
      >
        ← {ar.returns.back}
      </Link>
      <h2 className="text-2xl font-bold">
        {fill(ar.returns.fromInvoice, { number: invoice.number })} · {invoice.customer_name}
      </h2>

      {!invoice.canReturn ? (
        <p role="status" className="rounded-2xl bg-white p-4 font-bold">
          <span aria-hidden="true">ⓘ </span>
          {invoice.status === 'cancelled' ? ar.returns.unavailable : ar.returns.noInvoices}
        </p>
      ) : (
        <>
          <ul className="grid gap-3">
            {rows.map(({ entry, pick, qty, valid, amount }) => (
              <li key={entry.line.id} className="grid gap-2 rounded-2xl bg-white p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-bold">
                    {entry.line.product_name}
                    {entry.line.variant_label && (
                      <span className="block text-sm font-normal opacity-70">
                        {entry.line.variant_label}
                      </span>
                    )}
                  </span>
                  <span className="text-sm">
                    <bdi>
                      {entry.line.qty} × {formatMoney(entry.line.unit_price)}
                    </bdi>
                  </span>
                </div>
                {entry.returned > 0 && (
                  <p className="text-sm opacity-80">
                    {fill(ar.returns.returnedAlready, { n: entry.returned })}
                  </p>
                )}
                {entry.remaining === 0 ? (
                  <p className="font-bold">
                    <span aria-hidden="true">✓ </span>
                    {ar.returns.nothingLeft}
                  </p>
                ) : (
                  <>
                    <label className="grid gap-1">
                      <span className="font-bold">
                        {ar.returns.qty}{' '}
                        <span className="font-normal opacity-70">
                          {fill(ar.returns.qtyMax, { n: entry.remaining })}
                        </span>
                      </span>
                      <input
                        className={`${input} w-40`}
                        aria-label={`${ar.returns.qty} ${entry.line.product_name}`}
                        inputMode="numeric"
                        dir="ltr"
                        value={pick.qty}
                        aria-invalid={!valid}
                        onChange={(e) => set(entry.line.id, { qty: e.target.value })}
                      />
                    </label>
                    {!valid && (
                      <p role="alert" className="text-sm font-bold text-red-700">
                        <span aria-hidden="true">⚠ </span>
                        {ar.returns.badQty}{' '}
                        <bdi>
                          {fill(ar.returns.badQtyDetail, {
                            typed: pick.qty,
                            left: entry.remaining,
                          })}
                        </bdi>
                      </p>
                    )}
                    <fieldset className="grid gap-1">
                      <legend className="font-bold">{ar.returns.disposition}</legend>
                      <div className="flex flex-wrap gap-2">
                        {(['restock', 'damaged'] as const).map((d) => (
                          <button
                            key={d}
                            type="button"
                            aria-pressed={pick.disposition === d}
                            onClick={() => set(entry.line.id, { disposition: d })}
                            className={`min-h-12 rounded-full border-2 px-5 font-bold ${
                              pick.disposition === d
                                ? 'border-navy bg-navy text-white'
                                : 'border-navy/30 bg-white'
                            }`}
                          >
                            <span aria-hidden="true">{d === 'restock' ? '▲ ' : '✕ '}</span>
                            {ar.returns[d]}
                          </button>
                        ))}
                      </div>
                      <span className="text-sm opacity-70">
                        {pick.disposition === 'restock'
                          ? ar.returns.restockHint
                          : ar.returns.damagedHint}
                      </span>
                    </fieldset>
                    {qty > 0 && (
                      <p className="font-bold">
                        {ar.returns.credit}: <bdi>{formatMoney(amount)}</bdi>
                      </p>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>

          <label className="grid gap-1 rounded-2xl bg-white p-4">
            <span className="font-bold">{ar.returns.reason}</span>
            <input
              className={input}
              aria-label={ar.returns.reason}
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>

          <dl className="grid gap-1 rounded-2xl bg-white p-4">
            <div className="flex justify-between gap-4 text-lg font-bold">
              <dt>{ar.returns.total}</dt>
              <dd>
                <bdi>{formatMoney(total)}</bdi>
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>{ar.returns.before}</dt>
              <dd>
                <Balance agorot={balance} />
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>{ar.returns.after}</dt>
              <dd>{chosen.length > 0 ? <Balance agorot={after} /> : <bdi>—</bdi>}</dd>
            </div>
          </dl>
          {!ready && allValid && (
            <p role="status" className="font-bold">
              <span aria-hidden="true">ⓘ </span>
              {ar.returns.nothingPicked}
            </p>
          )}

          <button
            type="button"
            disabled={!ready}
            onClick={() => setConfirming(true)}
            className="min-h-14 rounded-xl bg-navy px-6 text-lg font-bold text-white disabled:opacity-40"
          >
            {ar.returns.confirm}
          </button>
        </>
      )}

      {confirming && (
        <ConfirmSheet
          title={ar.returns.confirmTitle}
          lines={[
            ...chosen.map((r) => ({
              label: `${r.entry.line.product_name} × ${r.qty} (${
                r.pick.disposition === 'restock' ? ar.returns.stockedLabel : ar.returns.damaged
              })`,
              value: formatMoney(r.amount),
            })),
            { label: ar.returns.total, value: formatMoney(total) },
            { label: ar.returns.before, value: formatMoney(balance) },
            { label: ar.returns.after, value: formatMoney(after) },
          ]}
          confirmLabel={ar.returns.confirm}
          busy={busy}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void save()}
        />
      )}
    </section>
  )
}
