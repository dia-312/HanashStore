import { Link } from 'react-router'
import { ar, fill } from '../i18n/ar'
import { loadDashboard, METHODS, type Dashboard } from '../lib/dashboard'
import { dayToDisplay } from '../lib/date'
import { formatMoney } from '../lib/money'
import { useNow } from '../lib/useNow'
import { useLive } from '../lib/useLive'
import { db } from '../db'

// The home screen (SPEC F12 and section 14): the numbers of the day, read from this device so they
// work offline and already count what has not been sent. Every state has a symbol and a word.

const card = 'grid content-start gap-2 rounded-2xl bg-white p-4 shadow-sm'
const big = 'text-3xl font-bold'
const action =
  'inline-flex min-h-14 items-center justify-center rounded-xl px-6 text-lg font-bold text-center'

function Money({ agorot }: { agorot: number }) {
  return <bdi dir="ltr">{formatMoney(agorot)}</bdi>
}

function Change({ percent }: { percent: number | null }) {
  if (percent === null) return <span>{ar.home.noComparison}</span>
  const up = percent > 0
  const flat = percent === 0
  return (
    <span className="font-bold">
      <span aria-hidden="true">{flat ? '■ ' : up ? '▲ ' : '▼ '}</span>
      {flat ? ar.home.same : fill(up ? ar.home.up : ar.home.down, { percent: Math.abs(percent) })}
    </span>
  )
}

function Cards({ d }: { d: Dashboard }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <section className={card} aria-labelledby="sales-today">
        <h3 id="sales-today" className="font-bold">
          {ar.home.salesToday}
        </h3>
        <p className={big}>
          <Money agorot={d.salesToday.net} />
        </p>
        <p>
          {fill(ar.home.invoicesCount, { n: d.salesToday.invoices })}
          {d.salesToday.returns > 0 && (
            <>
              {' · '}
              {ar.home.returnsIn} <Money agorot={d.salesToday.returns} />
            </>
          )}
        </p>
      </section>

      <section className={card} aria-labelledby="month">
        <h3 id="month" className="font-bold">
          {ar.home.thisMonth}
        </h3>
        <p className={big}>
          <Money agorot={d.month.net} />
        </p>
        <p>
          {ar.home.lastMonth}: <Money agorot={d.month.lastNet} />
        </p>
        <p className="text-sm">
          {fill(ar.home.sameDays, { n: d.month.days })} <Money agorot={d.month.lastSameDaysNet} /> ·{' '}
          <Change percent={d.month.changePercent} />
        </p>
      </section>

      <section className={`${card} md:col-span-2 xl:col-span-1`} aria-labelledby="collections">
        <h3 id="collections" className="font-bold">
          {ar.home.collectionsToday}
        </h3>
        <dl className="grid gap-1">
          {METHODS.map((m) => (
            <div key={m} className="flex justify-between gap-3">
              <dt>{ar.home.method[m]}</dt>
              <dd className="font-bold">
                <Money agorot={d.collectionsToday[m].net} />
              </dd>
            </div>
          ))}
          <div className="flex justify-between gap-3 border-t-2 border-navy/20 pt-1 text-lg">
            <dt className="font-bold">{ar.home.total}</dt>
            <dd className="font-bold">
              <Money agorot={d.collectionsToday.total.net} />
            </dd>
          </div>
        </dl>
        {d.collectionsToday.total.refunded > 0 && (
          <p className="text-sm">
            {ar.home.refundedIncluded} <Money agorot={d.collectionsToday.total.refunded} />
          </p>
        )}
        <p className="text-sm opacity-80">{ar.home.cashHint}</p>
      </section>

      <Link to="/customers" className={`${card} md:col-span-1`} aria-labelledby="owed">
        <h3 id="owed" className="font-bold">
          {ar.home.owed}
        </h3>
        <p className={big}>
          <Money agorot={d.owed.total} />
        </p>
        <p>
          {fill(ar.home.owingCustomers, { n: d.owed.customers })}
          {d.owed.credit > 0 && (
            <>
              {' · '}
              {ar.home.credit} <Money agorot={d.owed.credit} />
            </>
          )}
        </p>
      </Link>

      <Link to="/stock" className={card} aria-labelledby="stock">
        <h3 id="stock" className="font-bold">
          {ar.home.stock}
        </h3>
        <p className="flex flex-wrap gap-3 text-xl font-bold">
          <span>
            <span aria-hidden="true">▲ </span>
            {ar.home.low}: <bdi>{d.stock.low}</bdi>
          </span>
          <span>
            <span aria-hidden="true">✕ </span>
            {ar.home.out}: <bdi>{d.stock.out}</bdi>
          </span>
        </p>
        {d.stock.low + d.stock.out === 0 && (
          <p>
            <span aria-hidden="true">● </span>
            {ar.home.stockFine}
          </p>
        )}
      </Link>

      <Link to="/sync" className={card} aria-labelledby="sync">
        <h3 id="sync" className="font-bold">
          {ar.home.unsent}
        </h3>
        <p className={big}>
          <bdi>{d.sync.pending}</bdi>
        </p>
        {d.sync.rejected > 0 ? (
          <p className="font-bold">
            <span aria-hidden="true">⚠ </span>
            {fill(ar.home.refused, { n: d.sync.rejected })}
          </p>
        ) : d.sync.pending === 0 ? (
          <p>
            <span aria-hidden="true">✓ </span>
            {ar.home.allSent}
          </p>
        ) : (
          <p>
            <span aria-hidden="true">◔ </span>
            {ar.home.waiting}
          </p>
        )}
      </Link>
    </div>
  )
}

export default function Home() {
  // The day can turn while the screen is open: look again every minute.
  const minute = useNow(60_000)
  const dashboard = useLive(() => loadDashboard(new Date(minute).toISOString()), [minute])
  const products = useLive(() => db.products.count(), [])

  return (
    <section className="grid gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-2xl font-bold">{ar.nav.home}</h2>
        {dashboard && (
          <p className="opacity-80">
            {ar.home.today} <bdi>{dayToDisplay(dashboard.today)}</bdi>
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-3" role="group" aria-label={ar.home.quick}>
        <Link to="/present" className={`${action} bg-navy text-white`}>
          {ar.home.newSale}
        </Link>
        <Link to="/customers?pick=payment" className={`${action} border-2 border-navy/30 bg-white`}>
          {ar.home.newPayment}
        </Link>
        <Link to="/stock" className={`${action} border-2 border-navy/30 bg-white`}>
          {ar.home.stockIn}
        </Link>
      </div>

      {products === 0 && (
        <p className="rounded-2xl border-2 border-dashed border-navy/40 p-4">
          <span aria-hidden="true">→ </span>
          {ar.home.noProducts}{' '}
          <Link to="/settings/import" className="font-bold underline">
            {ar.empty.home.next}
          </Link>
        </p>
      )}

      {dashboard === undefined ? (
        <p aria-busy="true">{ar.common.loading}</p>
      ) : (
        <Cards d={dashboard} />
      )}
    </section>
  )
}
