import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Balance } from '../../components/Balance'
import { ConfirmSheet } from '../../components/ConfirmSheet'
import { ar, fill } from '../../i18n/ar'
import { buildCustomerProfile, loadSalesSnapshot } from '../../lib/localSales'
import { agorotToInput, formatMoney, parseMoney } from '../../lib/money'
import { recordRefund, SaleError } from '../../lib/sales'
import type { PaymentMethod } from '../../lib/sync/commands'
import { useLive } from '../../lib/useLive'

const METHODS: PaymentMethod[] = ['cash', 'transfer', 'cheque']
const input = 'min-h-12 rounded-xl border-2 border-navy/30 bg-white px-3 text-lg'

/** Money handed back to a customer, usually after a return he had already paid for. The amount
 * starts at what he is owed (his credit), and the balance before and after includes whatever is
 * still waiting to be sent. Works offline. */
export default function Refund() {
  const { customerId = '' } = useParams()
  const navigate = useNavigate()
  const customer = useLive(
    async () => buildCustomerProfile(await loadSalesSnapshot(), customerId),
    [customerId],
  )
  const [amountText, setAmountText] = useState<string | null>(null)
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (customer === undefined) return <p aria-busy="true">{ar.common.loading}</p>
  if (customer === null) return <p className="text-lg font-bold">{ar.customers.notFound}</p>

  const credit = customer.balance < 0 ? -customer.balance : 0
  // Until the rep types something, the box offers the whole credit he is owed.
  const text = amountText ?? (credit > 0 ? agorotToInput(credit) : '')
  const amount = text.trim() === '' ? null : parseMoney(text)
  const amountOk = amount !== null && amount > 0
  const chequeProblem = method === 'cheque' && note.trim() === ''
  const ready = amountOk && !chequeProblem
  const after = customer.balance + (amount ?? 0)

  const save = async () => {
    if (!amountOk) return
    setBusy(true)
    setError(null)
    try {
      await recordRefund({ customerId: customer.id, amount, method, note })
      void navigate(`/customers/${customer.id}`, { replace: true })
    } catch (e) {
      setError(
        e instanceof SaleError && e.code === 'CHEQUE_NOTE'
          ? ar.refund.chequeNote
          : ar.refund.failed,
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
        ← {ar.refund.back}
      </Link>
      <h2 className="text-2xl font-bold">
        {ar.refund.title} · {customer.name}
      </h2>
      <p>{ar.refund.hint}</p>
      <p role="status" className="rounded-2xl bg-white p-4 font-bold">
        <span aria-hidden="true">ⓘ </span>
        {credit > 0 ? fill(ar.refund.credit, { amount: formatMoney(credit) }) : ar.refund.noCredit}
      </p>

      <div className="grid gap-3 rounded-2xl bg-white p-4">
        <label className="grid gap-1">
          <span className="font-bold">{ar.refund.amount}</span>
          <input
            className={input}
            aria-label={ar.refund.amount}
            inputMode="decimal"
            dir="ltr"
            value={text}
            aria-invalid={text.trim() !== '' && !amountOk}
            onChange={(e) => setAmountText(e.target.value)}
          />
          {text.trim() !== '' && !amountOk && (
            <span role="alert" className="text-sm font-bold text-red-700">
              <span aria-hidden="true">⚠ </span>
              {ar.refund.badAmount}
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
          <span className="font-bold">
            {method === 'cheque' ? ar.refund.chequeNote : ar.refund.note}
          </span>
          <input
            className={input}
            aria-label={method === 'cheque' ? ar.refund.chequeNote : ar.refund.note}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>

      <dl className="grid gap-1 rounded-2xl bg-white p-4">
        <div className="flex justify-between gap-4">
          <dt>{ar.refund.before}</dt>
          <dd>
            <Balance agorot={customer.balance} />
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>{ar.refund.after}</dt>
          <dd>{amountOk ? <Balance agorot={after} /> : <bdi>—</bdi>}</dd>
        </div>
        {amountOk && after > 0 && (
          <p role="status" className="mt-1 font-bold">
            <span aria-hidden="true">ⓘ </span>
            {fill(ar.refund.moreThanCredit, { amount: formatMoney(after) })}
          </p>
        )}
      </dl>

      <button
        type="button"
        disabled={!ready}
        onClick={() => setConfirming(true)}
        className="min-h-14 rounded-xl bg-navy px-6 text-lg font-bold text-white disabled:opacity-40"
      >
        {ar.refund.confirm}
      </button>

      {confirming && amountOk && (
        <ConfirmSheet
          title={ar.refund.confirmTitle}
          lines={[
            { label: ar.refund.amount, value: formatMoney(amount) },
            { label: ar.checkout.method, value: ar.invoices.method[method] },
            { label: ar.refund.before, value: formatMoney(customer.balance) },
            { label: ar.refund.after, value: formatMoney(after) },
          ]}
          confirmLabel={ar.refund.confirm}
          busy={busy}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void save()}
        />
      )}
    </section>
  )
}
