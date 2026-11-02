import { useState } from 'react'
import { ar } from '../i18n/ar'
import type { StockStatus } from '../lib/catalogApi'
import { useCatalogFilters } from '../lib/catalogFilters'
import type { SortKey } from '../lib/localCatalog'
import { agorotToInput, parseMoney } from '../lib/money'

// The catalog's filter chips and order (SPEC section 9): colour, size, availability, price range.

const chip = (active: boolean) =>
  `min-h-11 shrink-0 rounded-full border-2 px-4 font-bold ${
    active ? 'border-navy bg-navy text-white' : 'border-navy/30 bg-white'
  }`

const AVAILABILITY: { value: StockStatus; label: string; shape: string }[] = [
  { value: 'ok', label: ar.status.ok, shape: '● ' },
  { value: 'low', label: ar.status.low, shape: '▲ ' },
  { value: 'out', label: ar.status.out, shape: '✕ ' },
]

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'relevance', label: ar.catalog.sortRelevance },
  { value: 'name', label: ar.catalog.sortName },
  { value: 'bestselling', label: ar.catalog.sortBest },
  { value: 'newest', label: ar.catalog.sortNewest },
  { value: 'price_low', label: ar.catalog.sortPriceLow },
  { value: 'price_high', label: ar.catalog.sortPriceHigh },
]

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="grid gap-1">
      <span className="font-bold">{label}</span>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

/** One end of the price range: empty = no limit; typed digits of any kind are understood. */
function PriceBox({
  label,
  value,
  onCommit,
}: {
  label: string
  value: number | undefined
  onCommit: (agorot: number | undefined) => void
}) {
  const [text, setText] = useState(value === undefined ? '' : agorotToInput(value))
  const bad = text.trim() !== '' && parseMoney(text) === null
  return (
    <label className="grid gap-1">
      <span>{label}</span>
      <input
        inputMode="decimal"
        value={text}
        aria-invalid={bad}
        onChange={(e) => {
          setText(e.target.value)
          const parsed = parseMoney(e.target.value)
          if (e.target.value.trim() === '') onCommit(undefined)
          else if (parsed !== null) onCommit(parsed)
        }}
        className="min-h-11 w-28 rounded-xl border-2 border-navy/30 bg-white px-3"
      />
      {bad && (
        <span role="alert" className="text-sm font-bold">
          <span aria-hidden="true">⚠ </span>
          {ar.catalog.badPriceRange}
        </span>
      )}
    </label>
  )
}

export function CatalogFilters({ colors, sizes }: { colors: string[]; sizes: string[] }) {
  const f = useCatalogFilters()
  return (
    <div className="grid gap-3 rounded-xl bg-white p-3" aria-label={ar.catalog.filters}>
      {colors.length > 0 && (
        <Group label={ar.catalog.color}>
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={f.color === c}
              onClick={() => f.set({ color: f.color === c ? undefined : c })}
              className={chip(f.color === c)}
            >
              {c}
            </button>
          ))}
        </Group>
      )}
      {sizes.length > 0 && (
        <Group label={ar.catalog.size}>
          {sizes.map((z) => (
            <button
              key={z}
              type="button"
              aria-pressed={f.size === z}
              onClick={() => f.set({ size: f.size === z ? undefined : z })}
              className={chip(f.size === z)}
            >
              <bdi>{z}</bdi>
            </button>
          ))}
        </Group>
      )}
      <Group label={ar.catalog.availability}>
        {AVAILABILITY.map((a) => (
          <button
            key={a.value}
            type="button"
            aria-pressed={f.availability === a.value}
            onClick={() =>
              f.set({ availability: f.availability === a.value ? undefined : a.value })
            }
            className={chip(f.availability === a.value)}
          >
            <span aria-hidden="true">{a.shape}</span>
            {a.label}
          </button>
        ))}
      </Group>
      <div role="group" aria-label={ar.catalog.price} className="flex flex-wrap items-start gap-3">
        <span className="basis-full font-bold">{ar.catalog.price}</span>
        <PriceBox
          label={ar.catalog.priceFrom}
          value={f.priceMin}
          onCommit={(priceMin) => f.set({ priceMin })}
        />
        <PriceBox
          label={ar.catalog.priceTo}
          value={f.priceMax}
          onCommit={(priceMax) => f.set({ priceMax })}
        />
      </div>
      <label className="grid gap-1">
        <span className="font-bold">{ar.catalog.sort}</span>
        <select
          value={f.sort}
          onChange={(e) => f.set({ sort: e.target.value as SortKey })}
          className="min-h-11 rounded-xl border-2 border-navy/30 bg-white px-3"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
