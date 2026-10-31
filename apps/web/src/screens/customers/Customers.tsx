import { memo, useDeferredValue, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Balance } from '../../components/Balance'
import { Tag } from '../../components/Tag'
import { VirtualRows } from '../../components/VirtualRows'
import { ar } from '../../i18n/ar'
import {
  buildCustomerList,
  loadSalesSnapshot,
  type CustomerItem,
  type CustomerSort,
} from '../../lib/localSales'
import { useLive } from '../../lib/useLive'

const chip = (active: boolean) =>
  `min-h-11 shrink-0 rounded-full border-2 px-4 font-bold ${
    active ? 'border-navy bg-navy text-white' : 'border-navy/30 bg-white'
  }`

const SORTS: CustomerSort[] = ['name', 'balance', 'lastInvoice']

const Row = memo(function Row({ item }: { item: CustomerItem }) {
  return (
    <Link
      to={`/customers/${item.id}`}
      className="flex min-h-20 items-center gap-3 rounded-xl bg-white p-3"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-lg font-bold">
          {item.name}
          {!item.is_active && <span className="ms-2 text-sm">({ar.customers.stopped})</span>}
        </span>
        <span className="block truncate text-sm opacity-70">
          {[item.shop_name, item.area].filter(Boolean).join(' · ')}
          {item.phone && (
            <>
              {item.shop_name || item.area ? ' · ' : ''}
              <bdi>{item.phone}</bdi>
            </>
          )}
        </span>
      </span>
      <span className="grid shrink-0 justify-items-end gap-1">
        <Balance agorot={item.balance} />
        {item.unsent && <Tag kind="wait">{ar.customers.unsent}</Tag>}
      </span>
    </Link>
  )
})

export function Customers() {
  const [text, setText] = useState('')
  // Typing never waits for the list: React renders the results when it has a free moment.
  const q = useDeferredValue(text.trim())
  const [sort, setSort] = useState<CustomerSort>('name')
  const [includeInactive, setIncludeInactive] = useState(false)
  const snapshot = useLive(loadSalesSnapshot, [])
  const items = useMemo(
    () => (snapshot ? buildCustomerList(snapshot, { q, sort, includeInactive }) : []),
    [snapshot, q, sort, includeInactive],
  )

  return (
    <section className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-bold">{ar.customers.title}</h2>
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={ar.customers.search}
          aria-label={ar.customers.search}
          className="min-h-12 min-w-48 flex-1 rounded-xl border-2 border-navy/30 bg-white px-4"
        />
        <Link
          to="/customers/new"
          className="inline-flex min-h-12 items-center rounded-xl bg-navy px-5 font-bold text-white"
        >
          + {ar.customers.add}
        </Link>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1" role="group">
        {SORTS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={sort === s}
            onClick={() => setSort(s)}
            className={chip(sort === s)}
          >
            {ar.customers.sort[s]}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={includeInactive}
          onClick={() => setIncludeInactive((v) => !v)}
          className={chip(includeInactive)}
        >
          {ar.customers.showStopped}
        </button>
      </div>
      {snapshot === undefined ? (
        <div aria-busy="true" className="grid gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-navy/10" />
          ))}
        </div>
      ) : items.length === 0 ? (
        q !== '' ? (
          <p className="py-10 text-center text-lg">{ar.customers.noResults}</p>
        ) : (
          <div className="grid place-items-center py-10 text-center">
            <div className="max-w-md">
              <h2 className="mb-2 text-2xl font-bold">{ar.empty.customers.title}</h2>
              <p className="mb-6">{ar.empty.customers.hint}</p>
              <Link
                to="/customers/new"
                className="inline-flex min-h-12 items-center rounded-xl bg-navy px-5 font-bold text-white"
              >
                {ar.empty.customers.next}
              </Link>
            </div>
          </div>
        )
      ) : (
        <VirtualRows
          items={items}
          estimate={88}
          keyOf={(c) => c.id}
          render={(c) => <Row item={c} />}
        />
      )}
    </section>
  )
}
