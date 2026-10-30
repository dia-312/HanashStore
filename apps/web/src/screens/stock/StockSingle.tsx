import { useState } from 'react'
import { ConfirmSheet } from '../../components/ConfirmSheet'
import { ErrorNotice } from '../../components/Notices'
import { StatusBadge } from '../../components/StatusBadge'
import { ar, fill } from '../../i18n/ar'
import { catalogApi, type StockResult, type VariantListItem } from '../../lib/catalogApi'
import { describeError } from '../../lib/errors'
import { uuid7 } from '../../lib/uuid7'
import { Result } from './StockIn'
import { VariantPicker, variantLabel } from './VariantPicker'

const input = 'min-h-12 w-full rounded-xl border-2 border-navy/30 bg-white px-3'
const MAX_QTY = 100_000

const whole = (text: string): number | null =>
  /^\d{1,6}$/.test(text) && Number(text) <= MAX_QTY ? Number(text) : null

/** The difference a count will record, shown before anything is saved. */
export function countDifference(current: number, counted: number): number {
  return counted - current
}

function Picked({ variant, onClear }: { variant: VariantListItem; onClear: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-3">
      <div>
        <div className="font-bold">{variantLabel(variant)}</div>
        <div className="text-sm opacity-70">
          <bdi>{variant.sku}</bdi>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <StatusBadge status={variant.status}>
          {ar.stock.current}: <bdi>{variant.stock_qty}</bdi>
        </StatusBadge>
        <button
          type="button"
          onClick={onClear}
          className="min-h-11 rounded-xl border-2 border-navy/30 px-4 font-bold"
        >
          {ar.form.close}
        </button>
      </div>
    </div>
  )
}

function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<StockResult | null>(null)
  const run = async (action: () => Promise<StockResult>) => {
    setBusy(true)
    setError(null)
    try {
      setResult(await action())
      return true
    } catch (e) {
      setError(describeError(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, result, run, clearError: () => setError(null) }
}

/** Count after a stock-take: the app records the difference, with a required reason. */
export function StockCount({ onAgain }: { onAgain: () => void }) {
  const [variant, setVariant] = useState<VariantListItem | null>(null)
  const [counted, setCounted] = useState('')
  const [note, setNote] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [requestId, setRequestId] = useState(uuid7)
  const action = useAction()

  const reset = () => {
    setVariant(null)
    setCounted('')
    setNote('')
    setReviewing(false)
    setRequestId(uuid7())
  }
  if (action.result) return <Result result={action.result} onAgain={onAgain} />
  if (!variant) return <VariantPicker onPick={setVariant} />

  const value = whole(counted)
  const difference = value === null ? null : countDifference(variant.stock_qty, value)
  const ready = value !== null && difference !== 0 && note.trim() !== ''

  return (
    <div className="grid max-w-xl gap-3">
      <Picked variant={variant} onClear={reset} />
      <label className="grid gap-1">
        <span className="font-bold">{ar.stock.counted}</span>
        <input
          className={input}
          inputMode="numeric"
          dir="ltr"
          value={counted}
          onChange={(e) => setCounted(e.target.value)}
        />
      </label>
      {difference !== null && (
        <p className="font-bold" role="status">
          {ar.stock.difference}: <bdi>{difference > 0 ? `+${difference}` : difference}</bdi>
          {difference === 0 && <span className="font-normal"> — {ar.stock.sameCount}</span>}
        </p>
      )}
      <label className="grid gap-1">
        <span className="font-bold">{ar.stock.countReason}</span>
        <input
          className={input}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!ready}
        onClick={() => setReviewing(true)}
        className="min-h-12 w-fit rounded-xl bg-navy px-6 font-bold text-white disabled:opacity-40"
      >
        {ar.stock.submitCount}
      </button>
      {reviewing && value !== null && difference !== null && (
        <ConfirmSheet
          title={ar.stock.confirmCountTitle}
          lines={[
            { label: ar.stock.current, value: String(variant.stock_qty) },
            { label: ar.stock.counted, value: String(value) },
            {
              label: ar.stock.difference,
              value: difference > 0 ? `+${difference}` : String(difference),
            },
          ]}
          message={note.trim()}
          confirmLabel={ar.form.confirm}
          busy={action.busy}
          error={action.error}
          onCancel={() => setReviewing(false)}
          onConfirm={() =>
            action.run(() =>
              catalogApi.stockAdjust({
                id: requestId,
                variant_id: variant.id,
                counted_qty: value,
                note: note.trim(),
              }),
            )
          }
        />
      )}
    </div>
  )
}

/** Mark units as damaged: they leave the stock, with a required reason. */
export function StockDamage({ onAgain }: { onAgain: () => void }) {
  const [variant, setVariant] = useState<VariantListItem | null>(null)
  const [qty, setQty] = useState('')
  const [note, setNote] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [requestId, setRequestId] = useState(uuid7)
  const action = useAction()

  const reset = () => {
    setVariant(null)
    setQty('')
    setNote('')
    setReviewing(false)
    setRequestId(uuid7())
  }
  if (action.result) return <Result result={action.result} onAgain={onAgain} />
  if (!variant) return <VariantPicker onPick={setVariant} />

  const value = whole(qty)
  const tooMuch = value !== null && value > variant.stock_qty
  const ready = value !== null && value >= 1 && !tooMuch && note.trim() !== ''

  return (
    <div className="grid max-w-xl gap-3">
      <Picked variant={variant} onClear={reset} />
      <label className="grid gap-1">
        <span className="font-bold">{ar.stock.damageQty}</span>
        <input
          className={input}
          inputMode="numeric"
          dir="ltr"
          value={qty}
          aria-invalid={tooMuch}
          onChange={(e) => setQty(e.target.value)}
        />
      </label>
      {tooMuch && <ErrorNotice message={fill(ar.stock.tooMuch, { n: variant.stock_qty })} />}
      <label className="grid gap-1">
        <span className="font-bold">{ar.stock.damageReason}</span>
        <input
          className={input}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!ready}
        onClick={() => setReviewing(true)}
        className="min-h-12 w-fit rounded-xl bg-navy px-6 font-bold text-white disabled:opacity-40"
      >
        {ar.stock.submitDamage}
      </button>
      {reviewing && value !== null && (
        <ConfirmSheet
          title={ar.stock.confirmDamageTitle}
          lines={[
            { label: ar.stock.current, value: String(variant.stock_qty) },
            { label: ar.stock.damageQty, value: String(value) },
            { label: ar.stock.afterQty, value: String(variant.stock_qty - value) },
          ]}
          message={note.trim()}
          confirmLabel={ar.form.confirm}
          busy={action.busy}
          error={action.error}
          onCancel={() => setReviewing(false)}
          onConfirm={() =>
            action.run(() =>
              catalogApi.stockDamage({
                id: requestId,
                variant_id: variant.id,
                qty: value,
                note: note.trim(),
              }),
            )
          }
        />
      )}
    </div>
  )
}
