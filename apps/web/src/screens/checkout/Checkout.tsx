import { useDeferredValue, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Balance } from '../../components/Balance'
import { ConfirmSheet } from '../../components/ConfirmSheet'
import { db } from '../../db'
import { ar, fill } from '../../i18n/ar'
import { invoiceTotals, lineTotal, remainingOnInvoice } from '../../lib/billing'
import { getCart, moveCartToCustomer } from '../../lib/cart'
import { loadSnapshot } from '../../lib/localCatalog'
import { buildCustomerList, loadSalesSnapshot } from '../../lib/localSales'
import { formatMoney, parseMoney } from '../../lib/money'
import { SaleError, confirmSale } from '../../lib/sales'
import type { PaymentMethod } from '../../lib/sync/commands'
import { pendingStock } from '../../lib/sync/effectiveStock'
import { useLive } from '../../lib/useLive'

const input = 'min-h-12 w-full rounded-xl border-2 border-navy/30 bg-white px-3'
const METHODS: PaymentMethod[] = ['cash', 'transfer', 'cheque']

/** Picks the customer when the sale began without one: search, then tap. */
function CustomerPicker({ onPick }: { onPick: (id: string) => void }) {
  const [text, setText] = useState('')
  const q = useDeferredValue(text.trim())
  const sales = useLive(loadSalesSnapshot, [])
  const matches = useMemo(
    () => (sales ? buildCustomerList(sales, { q }).slice(0, 8) : []),
    [sales, q],
  )
  return (
    <div className="grid gap-2 rounded-2xl bg-white p-4">
      <h3 className="font-bold">{ar.checkout.chooseCustomer}</h3>
      <input
        type="search"
        className={input}
        value={text}
        placeholder={ar.customers.search}
        aria-label={ar.customers.search}
        onChange={(e) => setText(e.target.value)}
      />
      {sales && sales.customers.length === 0 && (
        <p>
          {ar.checkout.noCustomers}{' '}
          <Link to="/customers/new" className="font-bold underline">
            {ar.customers.add}
          </Link>
        </p>
      )}
      <ul className="grid gap-2">
        {matches.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onPick(c.id)}
              className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border-2 border-navy/15 p-3 text-start"
            >
              <span className="font-bold">{c.name}</span>
              <Balance agorot={c.balance} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function Checkout() {
  const { customerId } = useParams()
  const navigate = useNavigate()
  const customerKey = customerId ?? null
  const cart = useLive(async () => (await getCart(customerKey)) ?? null, [customerKey])
  const catalog = useLive(loadSnapshot, [])
  const sales = useLive(loadSalesSnapshot, [])
  const customer = useLive(
    async () => (customerKey ? ((await db.customers.get(customerKey)) ?? null) : null),
    [customerKey],
  )

  const [discountText, setDiscountText] = useState('')
  const [paidText, setPaidText] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [payNote, setPayNote] = useState('')
  const [note, setNote] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const lines = useMemo(() => {
    if (!catalog || !cart) return []
    const stock = pendingStock(
      new Map(catalog.variants.map((v) => [v.id, v.stock_qty])),
      catalog.pending,
    )
    return cart.lines.flatMap((line) => {
      const variant = catalog.variants.find((v) => v.id === line.variant_id)
      if (!variant) return []
      const product = catalog.products.find((p) => p.id === variant.product_id)
      return [
        {
          variantId: variant.id,
          qty: line.qty,
          price: variant.price,
          name: product?.name ?? '',
          label: [variant.color, variant.size].filter(Boolean).join(' · '),
          available: Math.max(stock.get(variant.id) ?? variant.stock_qty, 0),
        },
      ]
    })
  }, [catalog, cart])

  const totals = lines.map((l) => lineTotal(l.qty, l.price))
  const subtotal = totals.reduce((a, b) => a + b, 0)
  const discount = discountText.trim() === '' ? 0 : parseMoney(discountText)
  const paid = paidText.trim() === '' ? null : parseMoney(paidText)
  const discountOk = discount !== null && discount <= subtotal
  const total = discountOk ? invoiceTotals(totals, discount).total : subtotal
  const remaining = paid === null ? total : remainingOnInvoice(total, paid)
  const balanceBefore = useMemo(() => {
    if (!sales || !customerKey) return 0
    return (
      buildCustomerList(sales, { includeInactive: true }).find((c) => c.id === customerKey)
        ?.balance ?? 0
    )
  }, [sales, customerKey])
  const balanceAfter = balanceBefore + total - (paid ?? 0)
  const stockProblem = lines.find((l) => l.qty > l.available)
  const chequeProblem = method === 'cheque' && (paid ?? 0) > 0 && payNote.trim() === ''
  const ready =
    customer !== null &&
    customer !== undefined &&
    lines.length > 0 &&
    discountOk &&
    paid !== null &&
    !stockProblem &&
    !chequeProblem

  const confirm = async () => {
    if (!customerKey || paid === null || discount === null) return
    setBusy(true)
    setError(null)
    try {
      const { invoiceId } = await confirmSale({
        customerId: customerKey,
        lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
        discount,
        paid,
        method,
        payNote,
        note,
      })
      navigate(`/invoices/${invoiceId}`, { replace: true })
    } catch (e) {
      setReviewing(false)
      if (e instanceof SaleError && e.code === 'INSUFFICIENT_STOCK') {
        const name = lines.find((l) => l.variantId === e.variantId)?.name ?? ''
        setError(fill(ar.checkout.stockProblem, { name, n: e.available ?? 0 }))
      } else if (e instanceof SaleError && e.code === 'BAD_DISCOUNT')
        setError(ar.checkout.badDiscount)
      else setError(ar.checkout.failed)
    } finally {
      setBusy(false)
    }
  }

  if (cart === undefined || catalog === undefined)
    return <p aria-busy="true">{ar.common.loading}</p>
  if (!cart || cart.lines.length === 0) {
    return (
      <section className="grid max-w-xl gap-3">
        <p className="text-lg font-bold">{ar.checkout.emptyCart}</p>
        <Link to="/catalog" className="font-bold underline">
          {ar.nav.catalog}
        </Link>
      </section>
    )
  }

  return (
    <section className="grid max-w-3xl gap-4">
      <h2 className="text-2xl font-bold">{ar.checkout.title}</h2>

      {customerKey === null ? (
        <CustomerPicker
          onPick={async (id) => {
            await moveCartToCustomer(id)
            navigate(`/checkout/${id}`, { replace: true })
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-4">
          <div>
            <div className="text-sm font-bold">{ar.checkout.customer}</div>
            <div className="text-xl font-bold">{customer?.name}</div>
          </div>
          <div className="text-end">
            <div className="text-sm font-bold">{ar.checkout.balanceBefore}</div>
            <Balance agorot={balanceBefore} />
          </div>
        </div>
      )}

      <div className="grid gap-2 rounded-2xl bg-white p-4">
        <h3 className="font-bold">{ar.checkout.lines}</h3>
        <ul className="grid gap-1">
          {lines.map((l, i) => (
            <li key={l.variantId} className="flex flex-wrap justify-between gap-2">
              <span>
                {l.name}
                {l.label && <span className="text-sm opacity-70"> · {l.label}</span>}
                <bdi className="ms-2 font-bold">× {l.qty}</bdi>
              </span>
              <bdi className="font-bold">{formatMoney(totals[i]!)}</bdi>
            </li>
          ))}
        </ul>
        {stockProblem && (
          <p role="alert" className="font-bold text-red-700">
            <span aria-hidden="true">⚠ </span>
            {fill(ar.checkout.stockProblem, { name: stockProblem.name, n: stockProblem.available })}
          </p>
        )}
        <div className="flex justify-between border-t border-navy/10 pt-2 font-bold">
          <span>{ar.invoices.subtotal}</span>
          <bdi>{formatMoney(subtotal)}</bdi>
        </div>
      </div>

      {customerKey !== null && (
        <div className="grid gap-3 rounded-2xl bg-white p-4">
          <label className="grid gap-1">
            <span className="font-bold">{ar.checkout.discount}</span>
            <input
              className={input}
              aria-label={ar.checkout.discount}
              inputMode="decimal"
              dir="ltr"
              value={discountText}
              aria-invalid={!discountOk}
              onChange={(e) => setDiscountText(e.target.value)}
            />
            {!discountOk && (
              <span role="alert" className="text-sm font-bold text-red-700">
                <span aria-hidden="true">⚠ </span>
                {discount === null ? ar.form.badPrice : ar.checkout.badDiscount}
              </span>
            )}
          </label>
          <label className="grid gap-1">
            <span className="font-bold">{ar.checkout.paidNow}</span>
            <input
              className={input}
              aria-label={ar.checkout.paidNow}
              inputMode="decimal"
              dir="ltr"
              value={paidText}
              aria-invalid={paidText.trim() !== '' && paid === null}
              onChange={(e) => setPaidText(e.target.value)}
            />
            <span className="text-sm opacity-70">{ar.checkout.paidHint}</span>
            {paidText.trim() !== '' && paid === null && (
              <span role="alert" className="text-sm font-bold text-red-700">
                <span aria-hidden="true">⚠ </span>
                {ar.checkout.badPaid}
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
          {method === 'cheque' && (paid ?? 0) > 0 && (
            <label className="grid gap-1">
              <span className="font-bold">{ar.checkout.chequeNote}</span>
              <input
                className={input}
                value={payNote}
                maxLength={500}
                onChange={(e) => setPayNote(e.target.value)}
              />
            </label>
          )}
          <label className="grid gap-1">
            <span className="font-bold">{ar.checkout.note}</span>
            <input
              className={input}
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>
      )}

      {customerKey !== null && (
        <div className="grid gap-2 rounded-2xl bg-white p-4">
          <h3 className="font-bold">{ar.checkout.summary}</h3>
          <dl className="grid gap-1">
            <div className="flex justify-between text-lg font-bold">
              <dt>{ar.checkout.total}</dt>
              <dd>
                <bdi>{formatMoney(total)}</bdi>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>{ar.checkout.paid}</dt>
              <dd>
                <bdi>{formatMoney(paid ?? 0)}</bdi>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>{ar.checkout.remaining}</dt>
              <dd>
                <bdi>{formatMoney(remaining)}</bdi>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>{ar.checkout.balanceAfter}</dt>
              <dd>
                <Balance agorot={balanceAfter} />
              </dd>
            </div>
          </dl>
          {balanceAfter < 0 && (
            <p role="status" className="font-bold">
              <span aria-hidden="true">ⓘ </span>
              {fill(ar.checkout.creditWarning, { amount: formatMoney(-balanceAfter) })}
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="font-bold text-red-700">
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      )}
      {customerKey !== null && (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={!ready}
            onClick={() => setReviewing(true)}
            className="min-h-14 rounded-xl bg-navy px-8 text-lg font-bold text-white disabled:opacity-40"
          >
            {ar.checkout.confirm}
          </button>
          <Link
            to={`/present/${customerKey}`}
            className="inline-flex min-h-14 items-center rounded-xl border-2 border-navy/30 bg-white px-6 font-bold"
          >
            {ar.checkout.back}
          </Link>
        </div>
      )}

      {reviewing && paid !== null && (
        <ConfirmSheet
          title={ar.checkout.confirmTitle}
          lines={[
            { label: ar.checkout.customer, value: customer?.name ?? '' },
            { label: ar.checkout.total, value: formatMoney(total) },
            { label: ar.checkout.paid, value: formatMoney(paid) },
            { label: ar.checkout.remaining, value: formatMoney(remaining) },
            { label: ar.checkout.balanceAfter, value: formatMoney(balanceAfter) },
          ]}
          message={
            balanceAfter < 0
              ? fill(ar.checkout.creditWarning, { amount: formatMoney(-balanceAfter) })
              : undefined
          }
          confirmLabel={ar.checkout.confirm}
          busy={busy}
          onCancel={() => setReviewing(false)}
          onConfirm={confirm}
        />
      )}
    </section>
  )
}
