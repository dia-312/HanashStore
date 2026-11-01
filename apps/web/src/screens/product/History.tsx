import { ErrorNotice } from '../../components/Notices'
import { ar, fill } from '../../i18n/ar'
import { catalogApi, type Movement, type Variant } from '../../lib/catalogApi'
import { formatDateTime } from '../../lib/date'
import { commandEffectOn } from '../../lib/sync/commands'
import { pendingCommands } from '../../lib/sync/outbox'
import { useLive } from '../../lib/useLive'
import { usePagedList } from '../../lib/usePagedList'

const TYPES = ar.product.movementTypes as Record<string, string>

/** Movement history of one variant, newest first, with the running total after each row. The list
 * is read page by page (50 at a time) instead of all at once (SPEC section 17). */
export function History({ variant, onClose }: { variant: Variant; onClose: () => void }) {
  const list = usePagedList<Movement>((cursor) => catalogApi.movements(variant.id, cursor))
  // Commands saved on this device that the server has not received yet: they are not in the list
  // the server returns, so they are shown above it, marked as waiting.
  const waiting = useLive(async () => {
    const commands = await pendingCommands()
    return commands.flatMap((c) => {
      const effect = commandEffectOn(c.type, c.payload, variant.id)
      return effect ? [{ id: c.id, created_at: c.created_at, ...effect }] : []
    })
  }, [variant.id])
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
      {waiting && waiting.length > 0 && (
        <div className="grid gap-2 rounded-xl border-2 border-dashed border-navy/40 p-3">
          <h4 className="font-bold">
            <span aria-hidden="true">◔ </span>
            {ar.product.waiting}
          </h4>
          <p className="text-sm">{ar.product.waitingHint}</p>
          <ul className="grid gap-2">
            {waiting.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-3">
                <span>
                  <span className="block font-bold">
                    {
                      TYPES[
                        w.type === 'stock.purchase'
                          ? 'purchase'
                          : w.type === 'stock.damage'
                            ? 'damage'
                            : w.type === 'return.create'
                              ? 'return'
                              : w.type === 'invoice.create'
                                ? 'sale'
                                : w.type === 'invoice.cancel'
                                  ? 'sale_cancel'
                                  : 'adjustment'
                      ]
                    }
                  </span>
                  <span className="block text-sm opacity-70">
                    <bdi>{formatDateTime(w.created_at)}</bdi>
                  </span>
                </span>
                <bdi className="font-bold">
                  {w.counted
                    ? fill(ar.product.waitingCount, { n: w.qty })
                    : w.qty > 0
                      ? `▲ +${w.qty}`
                      : `▼ ${w.qty}`}
                </bdi>
              </li>
            ))}
          </ul>
        </div>
      )}
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
