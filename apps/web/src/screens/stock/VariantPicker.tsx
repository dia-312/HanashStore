import { useEffect, useState } from 'react'
import { ErrorNotice } from '../../components/Notices'
import { StatusBadge } from '../../components/StatusBadge'
import { Thumb } from '../../components/Thumb'
import { ar } from '../../i18n/ar'
import { catalogApi, type VariantListItem } from '../../lib/catalogApi'
import { usePagedList } from '../../lib/usePagedList'

export function variantLabel(v: Pick<VariantListItem, 'product_name' | 'color' | 'size'>): string {
  const detail = [v.color, v.size].filter(Boolean).join(' · ')
  return detail ? `${v.product_name} — ${detail}` : v.product_name
}

function Results({ q, onPick }: { q: string; onPick: (v: VariantListItem) => void }) {
  const list = usePagedList<VariantListItem>((cursor) =>
    catalogApi.variants({ q, cursor, limit: 20 }),
  )
  if (list.loading && list.items.length === 0) return <p aria-busy="true">{ar.common.loading}</p>
  if (list.failed && list.items.length === 0)
    return <ErrorNotice message={ar.catalog.loadFailed} onRetry={list.retry} />
  if (list.items.length === 0) return <p className="opacity-70">{ar.stock.nothingFound}</p>
  return (
    <ul className="grid max-h-96 gap-2 overflow-auto">
      {list.items.map((v) => (
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
      {list.hasMore && (
        <li>
          <button
            type="button"
            disabled={list.loading}
            onClick={list.loadMore}
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
  const [q, setQ] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250)
    return () => clearTimeout(timer)
  }, [text])
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
