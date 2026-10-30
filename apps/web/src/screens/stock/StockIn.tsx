import { useState } from 'react'
import { ConfirmSheet } from '../../components/ConfirmSheet'
import { ErrorNotice } from '../../components/Notices'
import { ar, fill } from '../../i18n/ar'
import { catalogApi, type StockResult, type VariantListItem } from '../../lib/catalogApi'
import { describeError } from '../../lib/errors'
import { uuid7 } from '../../lib/uuid7'
import { VariantPicker, variantLabel } from './VariantPicker'

interface Line {
  id: string // made once per line, so a retried request can't count twice (SPEC section 8)
  variant: VariantListItem
  qty: string
}

const MAX_QTY = 100_000
const parseQty = (text: string) =>
  /^\d{1,6}$/.test(text) && Number(text) >= 1 && Number(text) <= MAX_QTY ? Number(text) : null

export function Result({ result, onAgain }: { result: StockResult; onAgain: () => void }) {
  return (
    <div role="status" className="grid gap-3 rounded-2xl bg-white p-4">
      <h3 className="text-lg font-bold">
        <span aria-hidden="true">✓ </span>
        {ar.stock.done}
      </h3>
      <ul className="grid gap-1">
        {result.variants.map((v) => (
          <li key={v.id}>
            <bdi>{v.sku}</bdi> — {fill(ar.stock.newQty, { n: v.stock_qty })}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onAgain}
        className="min-h-12 w-fit rounded-xl bg-navy px-6 font-bold text-white"
      >
        {ar.stock.another}
      </button>
    </div>
  )
}

export function StockIn({ onAgain }: { onAgain: () => void }) {
  const [lines, setLines] = useState<Line[]>([])
  const [note, setNote] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<StockResult | null>(null)

  const add = (variant: VariantListItem) =>
    setLines((current) =>
      current.some((l) => l.variant.id === variant.id)
        ? current
        : [...current, { id: uuid7(), variant, qty: '1' }],
    )
  const setQty = (id: string, qty: string) =>
    setLines((current) => current.map((l) => (l.id === id ? { ...l, qty } : l)))
  const remove = (id: string) => setLines((current) => current.filter((l) => l.id !== id))

  const valid = lines.length > 0 && lines.every((l) => parseQty(l.qty) !== null)
  const units = lines.reduce((sum, l) => sum + (parseQty(l.qty) ?? 0), 0)

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(
        await catalogApi.stockIn(
          note.trim() || null,
          lines.map((l) => ({ id: l.id, variant_id: l.variant.id, qty: parseQty(l.qty) ?? 0 })),
        ),
      )
      setReviewing(false)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  if (result) return <Result result={result} onAgain={onAgain} />

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <VariantPicker onPick={add} />
      <div className="grid content-start gap-3">
        {lines.length === 0 && <p className="opacity-70">{ar.stock.batchEmpty}</p>}
        <ul className="grid gap-2">
          {lines.map((l) => (
            <li
              key={l.id}
              className="grid grid-cols-[1fr_6rem_auto] items-center gap-2 rounded-xl bg-white p-2"
            >
              <span className="min-w-0">
                <span className="block truncate font-bold">{variantLabel(l.variant)}</span>
                <span className="block text-sm opacity-70">
                  {fill(ar.stock.inStock, { n: l.variant.stock_qty })}
                </span>
              </span>
              <input
                aria-label={`${ar.stock.qty}: ${variantLabel(l.variant)}`}
                className="min-h-12 w-full rounded-xl border-2 border-navy/30 px-2 text-center"
                inputMode="numeric"
                dir="ltr"
                value={l.qty}
                aria-invalid={parseQty(l.qty) === null}
                onChange={(e) => setQty(l.id, e.target.value)}
              />
              <button
                type="button"
                aria-label={ar.stock.remove}
                onClick={() => remove(l.id)}
                className="min-h-11 min-w-11 rounded-xl border-2 border-navy/30"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        {lines.length > 0 && (
          <>
            <input
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              placeholder={ar.stock.note}
              aria-label={ar.stock.note}
              className="min-h-12 w-full rounded-xl border-2 border-navy/30 bg-white px-4"
            />
            <button
              type="button"
              disabled={!valid}
              onClick={() => setReviewing(true)}
              className="min-h-12 w-fit rounded-xl bg-navy px-6 font-bold text-white disabled:opacity-40"
            >
              {ar.stock.submitIn}
            </button>
          </>
        )}
        {error && !reviewing && <ErrorNotice message={error} />}
      </div>
      {reviewing && (
        <ConfirmSheet
          title={ar.stock.confirmInTitle}
          lines={[
            { label: ar.stock.lines, value: String(lines.length) },
            { label: ar.stock.units, value: String(units) },
          ]}
          confirmLabel={ar.form.confirm}
          busy={busy}
          error={error}
          onCancel={() => setReviewing(false)}
          onConfirm={confirm}
        />
      )}
    </div>
  )
}
