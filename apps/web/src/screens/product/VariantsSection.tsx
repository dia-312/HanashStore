import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { ConfirmSheet } from '../../components/ConfirmSheet'
import { ErrorNotice } from '../../components/Notices'
import { StatusBadge } from '../../components/StatusBadge'
import { ar } from '../../i18n/ar'
import { catalogApi, type Variant } from '../../lib/catalogApi'
import { describeError } from '../../lib/errors'
import { agorotToInput, parseCount, parseMoney } from '../../lib/money'
import { History } from './History'

const input = 'min-h-12 w-full rounded-xl border-2 border-navy/30 bg-white px-3'
const smallButton = 'min-h-11 rounded-xl border-2 border-navy/30 bg-white px-4 font-bold'

const price = z.string().refine((s) => parseMoney(s) !== null, ar.form.badPrice)
const count = z.string().regex(/^\d{0,6}$/, ar.form.badQty)
const addVariantSchema = z.object({
  color: z.string().trim().max(100),
  size: z.string().trim().max(100),
  price: price,
  minStock: count,
  openingQty: count,
})

function label(v: Variant): string {
  return [v.color, v.size].filter(Boolean).join(' · ') || '—'
}

function VariantCard({
  variant,
  onChange,
  onHistory,
}: {
  variant: Variant
  onChange: () => Promise<void>
  onHistory: () => void
}) {
  const [priceText, setPriceText] = useState(agorotToInput(variant.price))
  const [minText, setMinText] = useState(String(variant.min_stock))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const parsedPrice = parseMoney(priceText)
  const parsedMin = (() => {
    const n = parseCount(minText)
    return n !== null && n <= 100_000 ? n : null
  })()
  const dirty = priceText !== agorotToInput(variant.price) || minText !== String(variant.min_stock)
  const valid = parsedPrice !== null && parsedMin !== null

  const patch = async (body: Parameters<typeof catalogApi.patchVariant>[1]) => {
    setBusy(true)
    setError(null)
    try {
      await catalogApi.patchVariant(variant.id, body)
      await onChange()
      setConfirming(false)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li
      className={`grid gap-3 rounded-xl border-2 border-navy/15 p-3 ${variant.is_active ? '' : 'opacity-60'}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-bold">{label(variant)}</span>{' '}
          <span className="text-sm opacity-70">
            {ar.product.sku}: <bdi>{variant.sku}</bdi>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!variant.is_active && <span className="font-bold">{ar.catalog.inactive}</span>}
          <StatusBadge status={variant.status}>
            {ar.status[variant.status]} · <bdi>{variant.stock_qty}</bdi>
          </StatusBadge>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1">
          <span className="text-sm font-bold">{ar.product.price}</span>
          <input
            className={input}
            inputMode="decimal"
            dir="ltr"
            value={priceText}
            onChange={(e) => setPriceText(e.target.value)}
            aria-invalid={parsedPrice === null}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-sm font-bold">{ar.product.minStock}</span>
          <input
            className={input}
            inputMode="numeric"
            dir="ltr"
            value={minText}
            onChange={(e) => setMinText(e.target.value)}
            aria-invalid={parsedMin === null}
          />
        </label>
      </div>
      {error && <ErrorNotice message={error} />}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!dirty || !valid || busy}
          onClick={() => patch({ price: parsedPrice ?? 0, min_stock: parsedMin ?? 0 })}
          className="min-h-11 rounded-xl bg-navy px-5 font-bold text-white disabled:opacity-40"
        >
          {busy ? ar.form.saving : ar.form.save}
        </button>
        <button type="button" onClick={onHistory} className={smallButton}>
          {ar.product.history}
        </button>
        <button
          type="button"
          onClick={() => (variant.is_active ? setConfirming(true) : patch({ is_active: true }))}
          className={smallButton}
        >
          {variant.is_active ? ar.product.deactivate : ar.product.activate}
        </button>
      </div>
      {confirming && (
        <ConfirmSheet
          title={ar.product.deactivate}
          message={ar.product.deactivateVariantConfirm}
          confirmLabel={ar.product.deactivate}
          busy={busy}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={() => patch({ is_active: false })}
        />
      )}
    </li>
  )
}

function AddVariant({ productId, onAdded }: { productId: string; onAdded: () => Promise<void> }) {
  const [values, setValues] = useState({
    color: '',
    size: '',
    price: '',
    minStock: '0',
    openingQty: '0',
  })
  const [errors, setErrors] = useState<Partial<Record<keyof typeof values, string>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const parsed = addVariantSchema.safeParse(values)
    if (!parsed.success) {
      const next: Partial<Record<keyof typeof values, string>> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof typeof values
        next[key] ??= issue.message
      }
      return setErrors(next)
    }
    setErrors({})
    setBusy(true)
    try {
      await catalogApi.createVariant(productId, {
        color: parsed.data.color || null,
        size: parsed.data.size || null,
        price: parseMoney(parsed.data.price) ?? 0,
        min_stock: Number(parsed.data.minStock || 0),
        opening_qty: Number(parsed.data.openingQty || 0),
      })
      setValues({ color: '', size: '', price: '', minStock: '0', openingQty: '0' })
      await onAdded()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const field = (key: keyof typeof values, text: string, mode?: 'decimal' | 'numeric') => (
    <label className="grid gap-1">
      <span className="text-sm font-bold">{text}</span>
      <input
        className={input}
        value={values[key]}
        onChange={set(key)}
        inputMode={mode}
        dir={mode ? 'ltr' : undefined}
        aria-invalid={errors[key] !== undefined}
      />
      {errors[key] && (
        <span role="alert" className="text-sm font-bold text-red-700">
          <span aria-hidden="true">⚠ </span>
          {errors[key]}
        </span>
      )}
    </label>
  )

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 rounded-xl border-2 border-dashed border-navy/40 p-3"
    >
      <h4 className="font-bold">{ar.product.addVariant}</h4>
      <p className="text-sm opacity-70">{ar.product.skuAuto}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {field('color', ar.product.color)}
        {field('size', ar.product.size)}
        {field('price', ar.product.price, 'decimal')}
        {field('minStock', ar.product.minStock, 'numeric')}
        {field('openingQty', ar.product.openingQty, 'numeric')}
      </div>
      {error && <ErrorNotice message={error} />}
      <button
        type="submit"
        disabled={busy}
        className="min-h-12 w-fit rounded-xl bg-navy px-6 font-bold text-white disabled:opacity-50"
      >
        {busy ? ar.form.saving : `+ ${ar.product.addVariant}`}
      </button>
    </form>
  )
}

export function VariantsSection({
  productId,
  variants,
  onChange,
}: {
  productId: string
  variants: Variant[]
  onChange: () => Promise<void>
}) {
  const [historyOf, setHistoryOf] = useState<Variant | null>(null)
  return (
    <section className="grid gap-3 rounded-2xl bg-white p-4">
      <h3 className="text-lg font-bold">{ar.product.variants}</h3>
      {variants.length === 0 && <p className="opacity-70">{ar.product.noVariantsYet}</p>}
      <ul className="grid gap-3">
        {variants.map((variant) => (
          <VariantCard
            key={`${variant.id}:${variant.price}:${variant.min_stock}`}
            variant={variant}
            onChange={onChange}
            onHistory={() => setHistoryOf(variant)}
          />
        ))}
      </ul>
      {historyOf && (
        <History
          key={`${historyOf.id}:${variants.find((v) => v.id === historyOf.id)?.stock_qty}`}
          variant={variants.find((v) => v.id === historyOf.id) ?? historyOf}
          onClose={() => setHistoryOf(null)}
        />
      )}
      <AddVariant productId={productId} onAdded={onChange} />
    </section>
  )
}
