import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Balance } from '../../components/Balance'
import { ConfirmSheet } from '../../components/ConfirmSheet'
import { ar, fill } from '../../i18n/ar'
import { hebronDay } from '../../lib/date'
import { buildCustomerProfile, loadSalesSnapshot } from '../../lib/localSales'
import { formatMoney, parseMoney } from '../../lib/money'
import { recordPayment, SaleError } from '../../lib/sales'
import type { PaymentMethod } from '../../lib/sync/commands'
import { useLive } from '../../lib/useLive'

const METHODS: PaymentMethod[] = ['cash', 'transfer', 'cheque']
const input = 'min-h-12 rounded-xl border-2 border-navy/30 bg-white px-3 text-lg'

/** Money received with no new order (SPEC F10): amount, method, date, note, then a sheet with the
 * numbers. Works offline; the balance before and after includes whatever is still waiting. */
export default function Payment() {
  const { customerId = '' } = useParams()
  const navigate = useNavigate()
  const customer = useLive(
    async () => buildCustomerProfile(await loadSalesSnapshot(), customerId),
    [customerId],
  )
  const today = useMemo(() => hebronDay(new Date().toISOString()), [])
  const [amountText, setAmountText] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [day, setDay] = useState(today)
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (customer === undefined) return <p aria-busy="true">{ar.common.loading}</p>
  if (customer === null) return <p className="text-lg font-bold">{ar.customers.notFound}</p>

  const amount = amountText.trim() === '' ? null : parseMoney(amountText)
  const amountOk = amount !== null && amount > 0
  const chequeProblem = method === 'cheque' && note.trim() === ''
  const dayOk = day !== '' && day <= today
  const ready = amountOk && !chequeProblem && dayOk
  const after = customer.balance - (amount ?? 0)

  const save = async () => {
    if (!amountOk) return
    setBusy(true)
    setError(null)
    try {
      await recordPayment({ customerId: customer.id, amount, method, note, day })
      void navigate(`/customers/${customer.id}`, { replace: true })
    } catch (e) {
      setError(
        e instanceof SaleError && e.code === 'CHEQUE_NOTE'
          ? ar.payment.chequeNote
          : ar.payment.failed,
      )
      setBusy(false)
    }
  }

  return (
    <section className="grid max-w-2xl gap-4">
      <Link
        to={`/customers/${customer.id}`}
        className="inline-flex min-h-11 w-fit items-center font-bold underline"
      >
        ← {ar.payment.back}
      </Link>
      <h2 className="text-2xl font-bold">
        {ar.payment.title} · {customer.name}
      </h2>

      <div className="grid gap-3 rounded-2xl bg-white p-4">
        <label className="grid gap-1">
          <span className="font-bold">{ar.payment.amount}</span>
          <input
            className={input}
            aria-label={ar.payment.amount}
            inputMode="decimal"
            dir="ltr"
            value={amountText}
            aria-invalid={amountText.trim() !== '' && !amountOk}
            onChange={(e) => setAmountText(e.target.value)}
          />
          <span className="text-sm opacity-70">{ar.payment.amountHint}</span>
          {amountText.trim() !== '' && !amountOk && (
            <span role="alert" className="text-sm font-bold text-red-700">
              <span aria-hidden="true">⚠ </span>
              {ar.payment.badAmount}
            </span>
          )}
        </label>

        <fieldset className="grid gap-2">
          <legend className="font-bold">{ar.checkout.method}</legend>
          <div className="flex flex-wrap gap-2">
            {METHODS.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={method === m}
                onClick={() => setMethod(m)}
                className={`min-h-12 rounded-full border-2 px-5 font-bold ${
                  method === m ? 'border-navy bg-navy text-white' : 'border-navy/30 bg-white'
                }`}
              >
                {ar.invoices.method[m]}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="grid gap-1">
          <span className="font-bold">{ar.payment.date}</span>
          <input
            type="date"
            dir="ltr"
            className={input}
            aria-label={ar.payment.date}
            value={day}
            max={today}
            onChange={(e) => setDay(e.target.value)}
          />
          {!dayOk && (
            <span role="alert" className="text-sm font-bold text-red-700">
              <span aria-hidden="true">⚠ </span>
              {ar.payment.badDate}
            </span>
          )}
        </label>

        <label className="grid gap-1">
          <span className="font-bold">
            {method === 'cheque' ? ar.checkout.chequeNote : ar.checkout.note}
          </span>
          <input
            className={input}
            aria-label={method === 'cheque' ? ar.checkout.chequeNote : ar.checkout.note}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>

      <dl className="grid gap-1 rounded-2xl bg-white p-4">
        <div className="flex justify-between gap-4">
          <dt>{ar.payment.before}</dt>
          <dd>
            <Balance agorot={customer.balance} />
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>{ar.payment.after}</dt>
          <dd>{amountOk ? <Balance agorot={after} /> : <bdi>—</bdi>}</dd>
        </div>
        {amountOk && after < 0 && (
          <p role="status" className="mt-1 font-bold">
            <span aria-hidden="true">ⓘ </span>
            {fill(ar.checkout.creditWarning, { amount: formatMoney(-after) })}
          </p>
        )}
      </dl>

      <button
        type="button"
        disabled={!ready}
        onClick={() => setConfirming(true)}
        className="min-h-14 rounded-xl bg-navy px-6 text-lg font-bold text-white disabled:opacity-40"
      >
        {ar.payment.confirm}
      </button>

      {confirming && amountOk && (
        <ConfirmSheet
          title={ar.payment.confirmTitle}
          lines={[
            { label: ar.payment.amount, value: formatMoney(amount) },
            { label: ar.checkout.method, value: ar.invoices.method[method] },
            { label: ar.payment.before, value: formatMoney(customer.balance) },
            { label: ar.payment.after, value: formatMoney(after) },
          ]}
          confirmLabel={ar.payment.confirm}
          busy={busy}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void save()}
        />
      )}
    </section>
  )
}
