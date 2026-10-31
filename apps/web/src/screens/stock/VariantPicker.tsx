import { useDeferredValue, useState } from 'react'
import { StatusBadge } from '../../components/StatusBadge'
import { Thumb } from '../../components/Thumb'
import { ar } from '../../i18n/ar'
import type { VariantListItem } from '../../lib/catalogApi'
import { buildVariantList, loadSnapshot } from '../../lib/localCatalog'
import { useLive } from '../../lib/useLive'

export function variantLabel(v: Pick<VariantListItem, 'product_name' | 'color' | 'size'>): string {
  const detail = [v.color, v.size].filter(Boolean).join(' · ')
  return detail ? `${v.product_name} — ${detail}` : v.product_name
}

const PAGE = 20

function Results({ q, onPick }: { q: string; onPick: (v: VariantListItem) => void }) {
  // Read from the device, so picking a variant works without a network.
  const all = useLive(async () => buildVariantList(await loadSnapshot(), q), [q])
  const [shown, setShown] = useState(PAGE)
  if (all === undefined) return <p aria-busy="true">{ar.common.loading}</p>
  if (all.length === 0) return <p className="opacity-70">{ar.stock.nothingFound}</p>
  const items = all.slice(0, shown)
  return (
    <ul className="grid max-h-96 gap-2 overflow-auto">
      {items.map((v) => (
        <li key={v.id}>
          <button
            type="button"
            onClick={() => onPick(v)}
            className="flex min-h-16 w-full items-center gap-3 rounded-xl border-2 border-navy/15 bg-white p-2 text-start"
          >
            <Thumb url={v.thumb_url} className="size-12 shrink-0 rounded-lg" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-bold">{variantLabel(v)}</span>
              <span className="block text-sm opacity-70">
                <bdi>{v.sku}</bdi>
              </span>
            </span>
            <StatusBadge status={v.status}>
              <bdi>{v.stock_qty}</bdi>
            </StatusBadge>
          </button>
        </li>
      ))}
      {all.length > shown && (
        <li>
          <button
            type="button"
            onClick={() => setShown((n) => n + PAGE)}
            className="min-h-11 w-full rounded-xl border-2 border-navy/30 font-bold"
          >
            {ar.catalog.loadMore}
          </button>
        </li>
      )}
    </ul>
  )
}

/** Search box plus results; tapping a result calls `onPick`. */
export function VariantPicker({ onPick }: { onPick: (v: VariantListItem) => void }) {
  const [text, setText] = useState('')
  // The list comes from the device, so there is nothing to wait for: results follow the typing
  // as soon as React has a free moment (no delay that could swap the list under a tap).
  const q = useDeferredValue(text.trim())
  return (
    <div className="grid gap-3">
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={ar.stock.search}
        aria-label={ar.stock.search}
        className="min-h-12 w-full rounded-xl border-2 border-navy/30 bg-white px-4"
      />
      <Results key={q} q={q} onPick={onPick} />
    </div>
  )
}
