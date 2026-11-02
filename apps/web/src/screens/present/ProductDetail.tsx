import { useEffect, useMemo, useRef, useState } from 'react'
import { Thumb } from '../../components/Thumb'
import { ar, fill } from '../../i18n/ar'
import { formatMoney } from '../../lib/money'
import type { Availability, PresentProduct, PresentVariant } from '../../lib/presentation'

// A product in presentation mode: pictures that swipe, colour and size buttons that pick the
// variant (and show its picture), and one card for the chosen variant with price, availability
// badge and the add button / quantity stepper. The shelf quantity is never shown.

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
        {images.map((image) => (
          <img
            key={image.id}
            src={image.full_url}
            alt={product.name}
            className="aspect-square w-full shrink-0 snap-center object-cover"
            draggable={false}
          />
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
    </div>
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
  const colors = useMemo(
    () => [...new Set(variants.map((v) => v.color).filter((c): c is string => !!c))],
    [variants],
  )
  const sizes = useMemo(
    () => [...new Set(variants.map((v) => v.size).filter((z): z is string => !!z))],
    [variants],
  )
  // The variant a search picked, else the first one that can be bought, else the first.
  const [chosenId, setChosenId] = useState<string>(
    () =>
      product.matched[0] ??
      variants.find((v) => v.availability !== 'unavailable')?.id ??
      variants[0]?.id ??
      '',
  )
  const chosen: PresentVariant | undefined = variants.find((v) => v.id === chosenId) ?? variants[0]

  // A colour picks the variant with that colour, keeping the size when that combination exists.
  const pick = (change: { color?: string | null; size?: string | null }) => {
    const color = change.color !== undefined ? change.color : (chosen?.color ?? null)
    const size = change.size !== undefined ? change.size : (chosen?.size ?? null)
    const next =
      variants.find((v) => v.color === color && v.size === size) ??
      variants.find((v) => (change.color !== undefined ? v.color === color : v.size === size))
    if (next) setChosenId(next.id)
  }

  const picture = chosen?.image?.id ?? null
  const qty = chosen ? inCart(chosen.id) : 0

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Gallery product={product} activeImageId={picture} />
      <div className="grid content-start gap-3">
        <h2 className="text-2xl font-bold">{product.name}</h2>
        {product.description && <p>{product.description}</p>}
        {colors.length > 0 && (
          <div role="group" aria-label={ar.present.color} className="grid gap-1">
            <span className="font-bold">{ar.present.color}</span>
            <div className="flex flex-wrap gap-2">
              {colors.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-pressed={chosen?.color === color}
                  onClick={() => pick({ color })}
                  className={choice(chosen?.color === color)}
                >
                  {chosen?.color === color && <span aria-hidden="true">✓ </span>}
                  {color}
                </button>
              ))}
            </div>
          </div>
        )}
        {sizes.length > 0 && (
          <div role="group" aria-label={ar.present.size} className="grid gap-1">
            <span className="font-bold">{ar.present.size}</span>
            <div className="flex flex-wrap gap-2">
              {sizes.map((size) => (
                <button
                  key={size}
                  type="button"
                  aria-pressed={chosen?.size === size}
                  onClick={() => pick({ size })}
                  className={choice(chosen?.size === size)}
                >
                  {chosen?.size === size && <span aria-hidden="true">✓ </span>}
                  <bdi>{size}</bdi>
                </button>
              ))}
            </div>
          </div>
        )}
        {chosen && (
          <section
            aria-label={ar.present.chosen}
            className="grid gap-2 rounded-xl bg-white p-3 sm:grid-cols-[1fr_auto] sm:items-center"
          >
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
          </section>
        )}
      </div>
    </div>
  )
}
