import { ErrorNotice } from '../../components/Notices'
import { ar } from '../../i18n/ar'
import { catalogApi, type Movement, type Variant } from '../../lib/catalogApi'
import { formatDateTime } from '../../lib/date'
import { usePagedList } from '../../lib/usePagedList'

const TYPES = ar.product.movementTypes as Record<string, string>

/** Movement history of one variant, newest first, with the running total after each row. The list
 * is read page by page (50 at a time) instead of all at once (SPEC section 17). */
export function History({ variant, onClose }: { variant: Variant; onClose: () => void }) {
  const list = usePagedList<Movement>((cursor) => catalogApi.movements(variant.id, cursor))
  return (
    <section className="grid gap-3 rounded-2xl border-2 border-navy bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-bold">
          {ar.product.history} · <bdi>{variant.sku}</bdi>
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-xl border-2 border-navy/30 px-4 font-bold"
        >
          {ar.form.close}
        </button>
      </div>
      {list.loading && list.items.length === 0 && <p aria-busy="true">{ar.common.loading}</p>}
      {list.failed && <ErrorNotice message={ar.catalog.loadFailed} onRetry={list.retry} />}
      {!list.loading && !list.failed && list.items.length === 0 && (
        <p className="opacity-70">{ar.product.noHistory}</p>
      )}
      <ul className="grid gap-2">
        {list.items.map((m) => (
          <li
            key={m.id}
            className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-navy/10 pb-2"
          >
            <span>
              <span className="block font-bold">{TYPES[m.type] ?? m.type}</span>
              <span className="block text-sm opacity-70">
                <bdi>{formatDateTime(m.created_at)}</bdi>
                {m.note ? ` · ${m.note}` : ''}
              </span>
            </span>
            <bdi className="font-bold">
              <span aria-hidden="true">{m.qty > 0 ? '▲ ' : '▼ '}</span>
              {m.qty > 0 ? `+${m.qty}` : m.qty}
            </bdi>
            <span className="text-end text-sm">
              {ar.product.runningTotal}: <bdi className="font-bold">{m.running_total}</bdi>
            </span>
          </li>
        ))}
      </ul>
      {list.hasMore && (
        <button
          type="button"
          disabled={list.loading}
          onClick={list.loadMore}
          className="min-h-12 rounded-xl border-2 border-navy/30 px-6 font-bold"
        >
          {ar.catalog.loadMore}
        </button>
      )}
    </section>
  )
}
