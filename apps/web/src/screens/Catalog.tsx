import { memo, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ErrorNotice, OfflineNotice } from '../components/Notices'
import { StatusBadge } from '../components/StatusBadge'
import { Thumb } from '../components/Thumb'
import { ar, fill } from '../i18n/ar'
import { catalogApi, type Category, type ProductListItem } from '../lib/catalogApi'
import { formatMoney } from '../lib/money'
import { useOnline } from '../lib/online'
import { usePagedList } from '../lib/usePagedList'

type View = 'grid' | 'list'
const VIEW_KEY = 'catalog-view'
const PAGE_SIZE = 50
const GAP = 12

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid' // storage can be blocked; the view is only a convenience
  }
}

const chip = (active: boolean) =>
  `min-h-11 shrink-0 rounded-full border-2 px-4 font-bold ${
    active ? 'border-navy bg-navy text-white' : 'border-navy/30 bg-white'
  }`

function priceText(item: ProductListItem): string {
  if (item.price_min === null || item.price_max === null) return ''
  return item.price_min === item.price_max
    ? formatMoney(item.price_min)
    : `${formatMoney(item.price_min)} – ${formatMoney(item.price_max)}`
}

function ProductBadge({ item }: { item: ProductListItem }) {
  if (item.variant_count === 0)
    return <StatusBadge status="none">{ar.catalog.noVariants}</StatusBadge>
  if (item.out_count === item.variant_count)
    return <StatusBadge status="out">{ar.status.out}</StatusBadge>
  if (item.out_count > 0)
    return <StatusBadge status="low">{fill(ar.catalog.outSome, { n: item.out_count })}</StatusBadge>
  if (item.low_count > 0)
    return <StatusBadge status="low">{fill(ar.catalog.lowSome, { n: item.low_count })}</StatusBadge>
  return (
    <StatusBadge status="ok">
      {ar.status.ok} · <bdi>{item.stock_total}</bdi>
    </StatusBadge>
  )
}

const ProductTile = memo(function ProductTile({
  item,
  asList,
}: {
  item: ProductListItem
  asList: boolean
}) {
  const inactive = !item.is_active && <span className="font-bold">{ar.catalog.inactive}</span>
  if (asList) {
    return (
      <Link
        to={`/catalog/${item.id}`}
        className="flex min-h-20 items-center gap-3 rounded-xl bg-white p-2"
      >
        <Thumb url={item.thumb_url} className="size-16 shrink-0 rounded-lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-bold">{item.name}</span>
          <span className="block truncate text-sm opacity-70">
            {item.category_name} ·{' '}
            {inactive || fill(ar.catalog.variantsCount, { n: item.variant_count })}
          </span>
        </span>
        <span className="shrink-0 text-end">
          <bdi className="block font-bold">{priceText(item)}</bdi>
          <ProductBadge item={item} />
        </span>
      </Link>
    )
  }
  return (
    <Link to={`/catalog/${item.id}`} className="block overflow-hidden rounded-xl bg-white">
      <Thumb url={item.thumb_url} />
      <span className="grid gap-1 p-3">
        <span className="line-clamp-2 min-h-12 font-bold">{item.name}</span>
        <span className="text-sm opacity-70">{inactive || item.category_name}</span>
        <bdi className="font-bold">{priceText(item)}</bdi>
        <span>
          <ProductBadge item={item} />
        </span>
      </span>
    </Link>
  )
})

/** Width of an element that may only appear after data loads: pass the element itself (kept in
 * state through a callback ref), not a ref object, so the observer starts when it mounts. */
function useWidth(element: HTMLElement | null) {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return width
}

/** Remounted (by `key`) whenever the search or filters change, so it always starts from page one. */
function ProductList({
  q,
  categoryId,
  includeInactive,
  view,
}: {
  q: string
  categoryId?: string
  includeInactive: boolean
  view: View
}) {
  const list = usePagedList<ProductListItem>((cursor) =>
    catalogApi.products({ q, categoryId, includeInactive, cursor, limit: PAGE_SIZE }),
  )
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const width = useWidth(scroller)
  const columns = view === 'list' ? 1 : Math.max(2, Math.floor(width / 190))
  const rows = Math.ceil(list.items.length / columns)
  const columnWidth = width > 0 ? (width - GAP * (columns - 1)) / columns : 190

  // TanStack's virtualizer is not memoizable by the React compiler; nothing here relies on that.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scroller,
    estimateSize: () => (view === 'list' ? 88 + GAP : columnWidth + 150 + GAP),
    overscan: 3,
    // Until the box is measured, assume it is as tall as the window: the first frame already has rows.
    initialRect: { width: 0, height: window.innerHeight },
    onChange: (instance) => {
      const last = instance.getVirtualItems().at(-1)
      if (last && last.index >= rows - 3) list.loadMore()
    },
  })

  if (list.loading && list.items.length === 0) {
    return (
      <div aria-busy="true" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="aspect-[3/4] animate-pulse rounded-xl bg-navy/10" />
        ))}
      </div>
    )
  }
  if (list.failed && list.items.length === 0)
    return <ErrorNotice message={ar.catalog.loadFailed} onRetry={list.retry} />
  if (list.items.length === 0) {
    const filtered = q !== '' || categoryId !== undefined
    return filtered ? (
      <p className="py-10 text-center text-lg">{ar.catalog.noResults}</p>
    ) : (
      <div className="grid place-items-center py-10 text-center">
        <div className="max-w-md">
          <h2 className="mb-2 text-2xl font-bold">{ar.empty.catalog.title}</h2>
          <p className="mb-6">{ar.empty.catalog.hint}</p>
          <Link
            to="/settings/import"
            className="inline-flex min-h-12 items-center rounded-xl bg-navy px-5 font-bold text-white"
          >
            {ar.empty.catalog.next}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div ref={setScroller} className="min-h-0 flex-1 overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtualizer.measureElement}
            className="absolute start-0 top-0 w-full pb-3"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {list.items.slice(row.index * columns, (row.index + 1) * columns).map((item) => (
                <ProductTile key={item.id} item={item} asList={view === 'list'} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {list.hasMore && (
        <div className="py-3 text-center">
          {list.failed ? (
            <ErrorNotice message={ar.catalog.loadFailed} onRetry={list.retry} />
          ) : (
            <button
              type="button"
              onClick={list.loadMore}
              disabled={list.loading}
              className="min-h-12 rounded-xl border-2 border-navy/30 bg-white px-6 font-bold"
            >
              {ar.catalog.loadMore}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function Catalog() {
  const online = useOnline()
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<string | undefined>()
  const [includeInactive, setIncludeInactive] = useState(false)
  const [view, setView] = useState<View>(loadView)
  const [categories, setCategories] = useState<Category[]>([])

  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250)
    return () => clearTimeout(timer)
  }, [text])

  useEffect(() => {
    if (!online) return
    catalogApi.categories().then(setCategories, () => undefined)
  }, [online])

  const chooseView = (next: View) => {
    setView(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      /* the choice just isn't remembered */
    }
  }

  return (
    <section className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-bold">{ar.catalog.title}</h2>
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={ar.catalog.search}
          aria-label={ar.catalog.search}
          className="min-h-12 min-w-48 flex-1 rounded-xl border-2 border-navy/30 bg-white px-4"
        />
        <div role="group" className="flex gap-1">
          <button
            type="button"
            aria-pressed={view === 'grid'}
            onClick={() => chooseView('grid')}
            className={chip(view === 'grid')}
          >
            ▦ {ar.catalog.grid}
          </button>
          <button
            type="button"
            aria-pressed={view === 'list'}
            onClick={() => chooseView('list')}
            className={chip(view === 'list')}
          >
            ☰ {ar.catalog.list}
          </button>
        </div>
        <Link
          to="/catalog/new"
          className="inline-flex min-h-12 items-center rounded-xl bg-navy px-5 font-bold text-white"
        >
          + {ar.catalog.newProduct}
        </Link>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1" role="group">
        <button
          type="button"
          aria-pressed={categoryId === undefined}
          onClick={() => setCategoryId(undefined)}
          className={chip(categoryId === undefined)}
        >
          {ar.catalog.all}
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={categoryId === c.id}
            onClick={() => setCategoryId(c.id)}
            className={chip(categoryId === c.id)}
          >
            {c.name}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={includeInactive}
          onClick={() => setIncludeInactive((v) => !v)}
          className={chip(includeInactive)}
        >
          {ar.catalog.inactive}
        </button>
      </div>
      {online ? (
        <ProductList
          key={`${q}|${categoryId ?? ''}|${includeInactive}`}
          q={q}
          categoryId={categoryId}
          includeInactive={includeInactive}
          view={view}
        />
      ) : (
        <OfflineNotice />
      )}
    </section>
  )
}
