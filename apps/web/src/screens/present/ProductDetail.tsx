import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { SoftBoundary } from '../../components/SoftBoundary'
import { Thumb } from '../../components/Thumb'
import { ar, fill } from '../../i18n/ar'
import { formatMoney } from '../../lib/money'
import type { Availability, PresentProduct, PresentVariant } from '../../lib/presentation'

// A product in presentation mode: pictures that swipe, size buttons that pick the variant (and
// show its picture; the colour is not a step), and one card for the chosen variant with price, availability
// badge and the add button / quantity stepper. The shelf quantity is never shown.

// The viewer is only needed when a picture is tapped, so it is not part of the first download.
const ImageViewer = lazy(() => import('../../components/ImageViewer'))

const big = 'min-h-14 min-w-14 rounded-xl border-2 border-navy/30 bg-white text-2xl font-bold'

const BADGE: Record<Availability, { shape: string; classes: string; label: string }> = {
  available: {
    shape: '●',
    classes: 'border-green-700 bg-green-50 text-green-900',
    label: ar.present.available,
  },
  limited: {
    shape: '▲',
    classes: 'border-amber-700 bg-amber-50 text-amber-900',
    label: ar.present.limited,
  },
  unavailable: {
    shape: '✕',
    classes: 'border-red-700 bg-red-50 text-red-900',
    label: ar.present.unavailable,
  },
}

export function Badge({ availability }: { availability: Availability }) {
  const { shape, classes, label } = BADGE[availability]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm font-bold ${classes}`}
    >
      <span aria-hidden="true">{shape}</span>
      {label}
    </span>
  )
}

export function Stepper({
  value,
  max,
  onChange,
  label,
}: {
  value: number
  max: number
  onChange: (qty: number) => void
  label: string
}) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label={label}>
      <button
        type="button"
        className={big}
        aria-label={ar.present.decrease}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <bdi className="min-w-10 text-center text-xl font-bold" aria-live="polite">
        {value}
      </bdi>
      <button
        type="button"
        className={`${big} disabled:opacity-30`}
        aria-label={ar.present.increase}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  )
}

const choice = (selected: boolean) =>
  `min-h-14 min-w-14 rounded-xl border-2 px-4 text-lg font-bold ${
    selected ? 'border-4 border-navy bg-navy/10' : 'border-navy/30 bg-white'
  }`

/** Pictures side by side that the customer swipes through; the active one follows the variant. */
function Gallery({
  product,
  activeImageId,
}: {
  product: PresentProduct
  activeImageId: string | null
}) {
  const rail = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const [viewing, setViewing] = useState<number | null>(null)
  const images = product.gallery

  useEffect(() => {
    if (!activeImageId) return
    const at = images.findIndex((i) => i.id === activeImageId)
    if (at < 0) return
    rail.current?.children[at]?.scrollIntoView?.({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest',
    })
  }, [activeImageId, images])

  if (images.length === 0) return <Thumb url={null} className="rounded-2xl" />
  return (
    <div className="grid gap-2">
      <div
        ref={rail}
        role="group"
        aria-label={product.name}
        onScroll={(e) => {
          const el = e.currentTarget
          if (el.clientWidth > 0) setIndex(Math.round(Math.abs(el.scrollLeft) / el.clientWidth))
        }}
        className="flex snap-x snap-mandatory overflow-x-auto rounded-2xl bg-white"
      >
        {images.map((image, at) => (
          <button
            key={image.id}
            type="button"
            aria-label={ar.present.zoomPicture}
            onClick={() => setViewing(at)}
            className="relative block w-full shrink-0 snap-center outline-accent focus-visible:outline-4 focus-visible:-outline-offset-4"
          >
            <img
              src={image.full_url}
              alt={product.name}
              className="aspect-square w-full object-cover"
              draggable={false}
            />
            <span
              aria-hidden="true"
              className="absolute bottom-2 end-2 grid size-10 place-items-center rounded-full bg-navy/70 text-cream"
            >
              <Icon name="zoom" className="size-5" />
            </span>
          </button>
        ))}
      </div>
      {images.length > 1 && (
        <div className="flex justify-center gap-2" role="group" aria-label={ar.present.pictures}>
          {images.map((image, at) => (
            <button
              key={image.id}
              type="button"
              aria-label={fill(ar.present.pictureN, { n: at + 1 })}
              aria-current={at === index}
              onClick={() =>
                rail.current?.children[at]?.scrollIntoView?.({
                  behavior: 'smooth',
                  inline: 'center',
                  block: 'nearest',
                })
              }
              className="grid min-h-11 min-w-11 place-items-center"
            >
              <span
                aria-hidden="true"
                className={`block rounded-full border-2 border-navy ${
                  at === index ? 'size-4 bg-navy' : 'size-3 bg-white'
                }`}
              />
            </button>
          ))}
        </div>
      )}
      {viewing !== null && (
        <SoftBoundary onError={() => setViewing(null)}>
          <Suspense fallback={null}>
            <ImageViewer
              images={images.map((i) => ({ id: i.id, url: i.full_url }))}
              alt={product.name}
              start={viewing}
              onClose={() => setViewing(null)}
            />
          </Suspense>
        </SoftBoundary>
      )}
    </div>
  )
}

/** What the customer taps to pick a variant: its size. The colour is not a step of its own; it is
 * only added to the label when two variants share a size (or there is no size), so they can still
 * be told apart. */
function optionLabels(variants: PresentVariant[]): Map<string, string> {
  const base = (v: PresentVariant) => v.size ?? v.color ?? '—'
  const counts = new Map<string, number>()
  for (const v of variants) counts.set(base(v), (counts.get(base(v)) ?? 0) + 1)
  return new Map(
    variants.map((v) => [
      v.id,
      (counts.get(base(v)) ?? 0) > 1 && v.size && v.color ? `${v.size} · ${v.color}` : base(v),
    ]),
  )
}

export function ProductDetail({
  product,
  inCart,
  onChange,
}: {
  product: PresentProduct
  inCart: (variantId: string) => number
  onChange: (variantId: string, qty: number, max: number) => void
}) {
  const { variants } = product
  const labels = useMemo(() => optionLabels(variants), [variants])
  const bySize = variants.some((v) => v.size)

  // Nothing is picked for the customer, unless there is nothing to pick from (one variant) or a
  // search already picked one.
  const [chosenId, setChosenId] = useState<string | null>(
    () => product.matched[0] ?? (variants.length === 1 ? (variants[0]?.id ?? null) : null),
  )
  const chosen: PresentVariant | undefined = variants.find((v) => v.id === chosenId)
  const picture = chosen?.image?.id ?? null
  const qty = chosen ? inCart(chosen.id) : 0
  const prices = variants.map((v) => v.price)
  const range =
    Math.min(...prices) === Math.max(...prices)
      ? formatMoney(prices[0] ?? 0)
      : `${formatMoney(Math.min(...prices))} – ${formatMoney(Math.max(...prices))}`

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Gallery product={product} activeImageId={picture} />
      <div className="grid content-start gap-3">
        <h2 className="text-2xl font-bold">{product.name}</h2>
        {product.description && <p>{product.description}</p>}
        {variants.length > 1 && (
          <div
            role="group"
            aria-label={bySize ? ar.present.size : ar.present.option}
            className="grid gap-1"
          >
            <span className="font-bold">{bySize ? ar.present.size : ar.present.option}</span>
            <div className="flex flex-wrap gap-2">
              {variants.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  aria-pressed={chosenId === v.id}
                  onClick={() => setChosenId(v.id)}
                  className={choice(chosenId === v.id)}
                >
                  {chosenId === v.id && <span aria-hidden="true">✓ </span>}
                  <bdi>{labels.get(v.id)}</bdi>
                </button>
              ))}
            </div>
          </div>
        )}
        <section
          aria-label={ar.present.chosen}
          className="grid gap-2 rounded-xl bg-white p-3 sm:grid-cols-[1fr_auto] sm:items-center"
        >
          {chosen ? (
            <>
              <span>
                <bdi className="block text-xl font-bold">{formatMoney(chosen.price)}</bdi>
                <Badge availability={chosen.availability} />
              </span>
              {qty === 0 ? (
                <button
                  type="button"
                  disabled={chosen.available < 1}
                  onClick={() => onChange(chosen.id, 1, chosen.available)}
                  className="min-h-14 rounded-xl bg-navy px-8 text-lg font-bold text-white disabled:opacity-40"
                >
                  {ar.present.add}
                </button>
              ) : (
                <Stepper
                  value={qty}
                  max={chosen.available}
                  label={fill(ar.present.inCart, { n: qty })}
                  onChange={(n) => onChange(chosen.id, n, chosen.available)}
                />
              )}
            </>
          ) : (
            <span>
              <bdi className="block text-xl font-bold">{range}</bdi>
              <span className="font-bold">
                <span aria-hidden="true">☝ </span>
                {bySize ? ar.present.pickSize : ar.present.pickOption}
              </span>
            </span>
          )}
        </section>
      </div>
    </div>
  )
}
