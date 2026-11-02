import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { BarChart } from '../../components/BarChart'
import { OfflineNotice } from '../../components/Notices'
import { StatusBadge } from '../../components/StatusBadge'
import { ar, fill } from '../../i18n/ar'
import { dayToDisplay, formatDate } from '../../lib/date'
import { describeError } from '../../lib/errors'
import { formatMoney } from '../../lib/money'
import { useOnline } from '../../lib/online'
import {
  presetRange,
  rangeOk,
  reportsApi,
  todayInHebron,
  type BalancesReport,
  type CollectionsReport,
  type DamagedReport,
  type Preset,
  type ProductsReport,
  type Range,
  type SalesReport,
  type StockReport,
  type StockRow,
} from '../../lib/reportsApi'

// Reports (SPEC F12): computed on the server from the books, so they need the internet. Each tab
// shows its numbers as a table; the charts only repeat them.

type Tab = 'sales' | 'products' | 'collections' | 'balances' | 'stock' | 'damaged'
const TABS: Tab[] = ['sales', 'products', 'collections', 'balances', 'stock', 'damaged']
const HAS_PERIOD: Tab[] = ['sales', 'products', 'collections', 'damaged']
const PRESETS: Preset[] = ['today', 'week', 'month', 'lastMonth', 'quarter', 'year']

const chip = (on: boolean) =>
  `min-h-11 shrink-0 rounded-full border-2 px-4 font-bold ${
    on ? 'border-navy bg-navy text-white' : 'border-navy/30 bg-white'
  }`
const th = 'px-3 py-2 text-start font-bold'
const td = 'px-3 py-2'

const Money = ({ agorot }: { agorot: number }) => <bdi dir="ltr">{formatMoney(agorot)}</bdi>

const periodLabel = (key: string) =>
  key.length === 7 ? key.split('-').reverse().join('/') : dayToDisplay(key)

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      <span className="font-bold">{label}:</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={chip(value === o.value)}
        >
          {value === o.value && <span aria-hidden="true">✓ </span>}
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl bg-white">
      <table className="w-full min-w-[32rem] border-collapse">
        <thead className="border-b-2 border-navy/20">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y divide-navy/10">{children}</tbody>
      </table>
    </div>
  )
}

/** Loads one report; reloads when `key` changes; keeps the last error for a retry button. */
function useReport<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ data?: T; error?: string; key?: string }>({})
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    load().then(
      (data) => live && setState({ data, key }),
      (e: unknown) => live && setState({ error: describeError(e), key }),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` describes what `load` reads
  }, [key, attempt])
  const loading = state.key !== key
  return {
    data: loading ? undefined : state.data,
    error: loading ? undefined : state.error,
    loading,
    retry: () => {
      setState({})
      setAttempt((n) => n + 1)
    },
  }
}

function Body<T>({
  report,
  children,
}: {
  report: ReturnType<typeof useReport<T>>
  children: (data: T) => ReactNode
}) {
  if (report.loading) return <p aria-busy="true">{ar.reports.loading}</p>
  if (report.error || !report.data)
    return (
      <p role="alert" className="flex flex-wrap items-center gap-3 font-bold text-red-700">
        <span>
          <span aria-hidden="true">⚠ </span>
          {report.error ?? ar.reports.failed}
        </span>
        <button type="button" onClick={report.retry} className={chip(false)}>
          {ar.reports.retry}
        </button>
      </p>
    )
  return <>{children(report.data)}</>
}

// ---- the tabs -------------------------------------------------------------------------------

function Sales({ range }: { range: Range }) {
  const [group, setGroup] = useState<'day' | 'month'>('day')
  const report = useReport<SalesReport>(
    () => reportsApi.sales(range, group),
    `${range.from}|${range.to}|${group}`,
  )
  return (
    <div className="grid gap-4">
      <Segmented
        label={ar.reports.sales.group}
        value={group}
        onChange={setGroup}
        options={[
          { value: 'day', label: ar.reports.sales.day },
          { value: 'month', label: ar.reports.sales.month },
        ]}
      />
      <Body report={report}>
        {(r) => (
          <>
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {(
                [
                  [ar.reports.sales.invoices, <bdi key="i">{r.invoices}</bdi>],
                  [ar.reports.sales.gross, <Money key="g" agorot={r.gross} />],
                  [ar.reports.sales.returns, <Money key="r" agorot={r.returns} />],
                  [ar.reports.sales.net, <Money key="n" agorot={r.net} />],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="rounded-xl bg-white p-3">
                  <dt>{label}</dt>
                  <dd className="text-2xl font-bold">{value}</dd>
                </div>
              ))}
            </dl>
            <BarChart
              caption={ar.reports.sales.chart}
              bars={r.rows.map((row) => ({ label: periodLabel(row.period), value: row.net }))}
            />
            <Table
              head={
                <>
                  <th className={th}>{ar.reports.sales.period}</th>
                  <th className={th}>{ar.reports.sales.invoices}</th>
                  <th className={th}>{ar.reports.sales.gross}</th>
                  <th className={th}>{ar.reports.sales.returns}</th>
                  <th className={th}>{ar.reports.sales.net}</th>
                </>
              }
            >
              {[...r.rows].reverse().map((row) => (
                <tr key={row.period}>
                  <td className={td}>
                    <bdi dir="ltr">{periodLabel(row.period)}</bdi>
                  </td>
                  <td className={td}>
                    <bdi>{row.invoices}</bdi>
                  </td>
                  <td className={td}>
                    <Money agorot={row.gross} />
                  </td>
                  <td className={td}>
                    <Money agorot={row.returns} />
                  </td>
                  <td className={`${td} font-bold`}>
                    <Money agorot={row.net} />
                  </td>
                </tr>
              ))}
            </Table>
            <p className="text-sm opacity-80">{ar.reports.sales.note}</p>
          </>
        )}
      </Body>
    </div>
  )
}

function Products({ range }: { range: Range }) {
  const [by, setBy] = useState<'product' | 'variant' | 'category'>('product')
  const [order, setOrder] = useState<'top' | 'slow'>('top')
  const report = useReport<ProductsReport>(
    () => reportsApi.products(range, by, order),
    `${range.from}|${range.to}|${by}|${order}`,
  )
  return (
    <div className="grid gap-4">
      <Segmented
        label={ar.reports.products.by}
        value={by}
        onChange={setBy}
        options={[
          { value: 'product', label: ar.reports.products.product },
          { value: 'variant', label: ar.reports.products.variant },
          { value: 'category', label: ar.reports.products.category },
        ]}
      />
      <Segmented
        label={ar.reports.products.order}
        value={order}
        onChange={setOrder}
        options={[
          { value: 'top', label: ar.reports.products.top },
          { value: 'slow', label: ar.reports.products.slow },
        ]}
      />
      <Body report={report}>
        {(r) =>
          r.rows.length === 0 ? (
            <p>{ar.reports.empty}</p>
          ) : (
            <>
              <Table
                head={
                  <>
                    <th className={th}>{ar.reports.products.name}</th>
                    <th className={th}>{ar.reports.products.qty}</th>
                    <th className={th}>{ar.reports.products.amount}</th>
                  </>
                }
              >
                {r.rows.map((row) => (
                  <tr key={row.id}>
                    <td className={td}>
                      <span className="font-bold">{row.name}</span>
                      {row.detail && <span className="block text-sm opacity-70">{row.detail}</span>}
                    </td>
                    <td className={td}>
                      <bdi>{row.qty}</bdi>
                    </td>
                    <td className={`${td} font-bold`}>
                      <Money agorot={row.amount} />
                    </td>
                  </tr>
                ))}
              </Table>
              <p className="text-sm opacity-80">{ar.reports.products.note}</p>
            </>
          )
        }
      </Body>
    </div>
  )
}

function Collections({ range }: { range: Range }) {
  const report = useReport<CollectionsReport>(
    () => reportsApi.collections(range),
    `${range.from}|${range.to}`,
  )
  const head = (first: string) => (
    <>
      <th className={th}>{first}</th>
      <th className={th}>{ar.reports.collections.received}</th>
      <th className={th}>{ar.reports.collections.refunded}</th>
      <th className={th}>{ar.reports.collections.net}</th>
    </>
  )
  return (
    <Body report={report}>
      {(r) => (
        <div className="grid gap-4">
          <h3 className="text-lg font-bold">{ar.reports.collections.byMethod}</h3>
          <Table head={head(ar.reports.collections.method)}>
            {r.by_method.map((row) => (
              <tr key={row.key}>
                <td className={td}>{ar.home.method[row.key as 'cash' | 'transfer' | 'cheque']}</td>
                <td className={td}>
                  <Money agorot={row.received} />
                </td>
                <td className={td}>
                  <Money agorot={row.refunded} />
                </td>
                <td className={`${td} font-bold`}>
                  <Money agorot={row.net} />
                </td>
              </tr>
            ))}
            <tr className="bg-navy/5">
              <td className={`${td} font-bold`}>{ar.home.total}</td>
              <td className={`${td} font-bold`}>
                <Money agorot={r.received} />
              </td>
              <td className={`${td} font-bold`}>
                <Money agorot={r.refunded} />
              </td>
              <td className={`${td} font-bold`}>
                <Money agorot={r.net} />
              </td>
            </tr>
          </Table>
          <h3 className="text-lg font-bold">{ar.reports.collections.byDay}</h3>
          <BarChart
            caption={ar.reports.collections.chart}
            bars={r.by_day.map((row) => ({ label: periodLabel(row.key), value: row.net }))}
          />
          <Table head={head(ar.reports.collections.day)}>
            {[...r.by_day].reverse().map((row) => (
              <tr key={row.key}>
                <td className={td}>
                  <bdi dir="ltr">{periodLabel(row.key)}</bdi>
                </td>
                <td className={td}>
                  <Money agorot={row.received} />
                </td>
                <td className={td}>
                  <Money agorot={row.refunded} />
                </td>
                <td className={`${td} font-bold`}>
                  <Money agorot={row.net} />
                </td>
              </tr>
            ))}
          </Table>
          <p className="text-sm opacity-80">{ar.reports.collections.note}</p>
        </div>
      )}
    </Body>
  )
}

function Balances() {
  const [sort, setSort] = useState<'balance' | 'days'>('balance')
  const [onlyOwing, setOnlyOwing] = useState(true)
  const report = useReport<BalancesReport>(() => reportsApi.balances(), 'balances')
  return (
    <div className="grid gap-4">
      <Segmented
        label={ar.reports.balances.sort}
        value={sort}
        onChange={setSort}
        options={[
          { value: 'balance', label: ar.reports.balances.byBalance },
          { value: 'days', label: ar.reports.balances.byDays },
        ]}
      />
      <button
        type="button"
        aria-pressed={onlyOwing}
        onClick={() => setOnlyOwing((v) => !v)}
        className={`${chip(onlyOwing)} w-fit`}
      >
        {onlyOwing && <span aria-hidden="true">✓ </span>}
        {ar.reports.balances.onlyOwing}
      </button>
      <Body report={report}>
        {(r) => {
          const rows = r.rows
            .filter((row) => !onlyOwing || row.balance > 0)
            .sort((a, b) =>
              sort === 'balance'
                ? b.balance - a.balance
                : (b.days_since_payment ?? Infinity) - (a.days_since_payment ?? Infinity) ||
                  b.balance - a.balance,
            )
          return (
            <>
              <dl className="grid grid-cols-3 gap-3">
                <div className="rounded-xl bg-white p-3">
                  <dt>{ar.reports.balances.owed}</dt>
                  <dd className="text-2xl font-bold">
                    <Money agorot={r.total_owed} />
                  </dd>
                </div>
                <div className="rounded-xl bg-white p-3">
                  <dt>{ar.reports.balances.owing}</dt>
                  <dd className="text-2xl font-bold">
                    <bdi>{r.owing}</bdi>
                  </dd>
                </div>
                <div className="rounded-xl bg-white p-3">
                  <dt>{ar.reports.balances.credit}</dt>
                  <dd className="text-2xl font-bold">
                    <Money agorot={r.total_credit} />
                  </dd>
                </div>
              </dl>
              {rows.length === 0 ? (
                <p>{ar.reports.empty}</p>
              ) : (
                <Table
                  head={
                    <>
                      <th className={th}>{ar.reports.balances.customer}</th>
                      <th className={th}>{ar.reports.balances.balance}</th>
                      <th className={th}>{ar.reports.balances.lastPayment}</th>
                      <th className={th}>{ar.reports.balances.days}</th>
                    </>
                  }
                >
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className={td}>
                        <Link to={`/customers/${row.id}`} className="font-bold underline">
                          {row.name}
                        </Link>
                        {row.shop_name && (
                          <span className="block text-sm opacity-70">{row.shop_name}</span>
                        )}
                      </td>
                      <td className={`${td} font-bold`}>
                        <Money agorot={row.balance} />
                      </td>
                      <td className={td}>
                        {row.last_payment_at ? (
                          <bdi dir="ltr">{formatDate(row.last_payment_at)}</bdi>
                        ) : (
                          ar.reports.balances.never
                        )}
                      </td>
                      <td className={td}>
                        {row.days_since_payment === null ? (
                          '—'
                        ) : (
                          <bdi>{row.days_since_payment}</bdi>
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </>
          )
        }}
      </Body>
    </div>
  )
}

function StockList({
  title,
  hint,
  rows,
  status,
}: {
  title: string
  hint?: string
  rows: StockRow[]
  status: 'ok' | 'low' | 'out'
}) {
  return (
    <section className="grid gap-2">
      <h3 className="flex flex-wrap items-center gap-2 text-lg font-bold">
        <StatusBadge status={status}>{title}</StatusBadge>
        <bdi>{rows.length}</bdi>
      </h3>
      {hint && rows.length > 0 && <p className="text-sm">{hint}</p>}
      {rows.length === 0 ? (
        <p className="opacity-70">{ar.reports.stock.none}</p>
      ) : (
        <Table
          head={
            <>
              <th className={th}>{ar.reports.products.name}</th>
              <th className={th}>{ar.reports.stock.qty}</th>
              <th className={th}>{ar.reports.stock.min}</th>
            </>
          }
        >
          {rows.map((row) => (
            <tr key={row.variant_id}>
              <td className={td}>
                <Link to={`/catalog/${row.product_id}`} className="font-bold underline">
                  {row.name}
                </Link>
                <span className="block text-sm opacity-70">
                  {[row.color, row.size].filter(Boolean).join(' · ')}
                </span>
              </td>
              <td className={`${td} font-bold`}>
                <bdi>{row.qty}</bdi>
              </td>
              <td className={td}>
                <bdi>{row.min_stock}</bdi>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  )
}

function Stock() {
  const report = useReport<StockReport>(() => reportsApi.stock(), 'stock')
  return (
    <Body report={report}>
      {(r) => (
        <div className="grid gap-6">
          <StockList
            title={ar.reports.stock.negative}
            hint={ar.reports.stock.negativeHint}
            rows={r.negative}
            status="out"
          />
          <StockList title={ar.reports.stock.out} rows={r.out} status="out" />
          <StockList title={ar.reports.stock.low} rows={r.low} status="low" />
        </div>
      )}
    </Body>
  )
}

function Damaged({ range }: { range: Range }) {
  const report = useReport<DamagedReport>(
    () => reportsApi.damaged(range),
    `${range.from}|${range.to}`,
  )
  return (
    <Body report={report}>
      {(r) => (
        <div className="grid gap-4">
          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-white p-3">
              <dt>{ar.reports.damaged.writeOffTotal}</dt>
              <dd className="text-2xl font-bold">
                <bdi>{r.write_off_qty}</bdi>
              </dd>
            </div>
            <div className="rounded-xl bg-white p-3">
              <dt>{ar.reports.damaged.returnedTotal}</dt>
              <dd className="text-2xl font-bold">
                <bdi>{r.return_qty}</bdi>
              </dd>
            </div>
          </dl>
          {r.rows.length === 0 ? (
            <p>{ar.reports.empty}</p>
          ) : (
            <Table
              head={
                <>
                  <th className={th}>{ar.reports.damaged.date}</th>
                  <th className={th}>{ar.reports.products.name}</th>
                  <th className={th}>{ar.reports.damaged.qty}</th>
                  <th className={th}>{ar.reports.damaged.source}</th>
                  <th className={th}>{ar.reports.damaged.note}</th>
                </>
              }
            >
              {r.rows.map((row, i) => (
                <tr key={`${row.variant_id}-${row.at}-${i}`}>
                  <td className={td}>
                    <bdi dir="ltr">{formatDate(row.at)}</bdi>
                  </td>
                  <td className={td}>
                    <span className="font-bold">{row.name}</span>
                    <span className="block text-sm opacity-70">
                      {[row.color, row.size].filter(Boolean).join(' · ')}
                    </span>
                  </td>
                  <td className={td}>
                    <bdi>{row.qty}</bdi>
                  </td>
                  <td className={td}>
                    {row.source === 'write_off'
                      ? ar.reports.damaged.writeOff
                      : ar.reports.damaged.returned}
                    {row.ref && (
                      <span className="block text-sm opacity-70">
                        <bdi dir="ltr">{row.ref}</bdi>
                      </span>
                    )}
                  </td>
                  <td className={td}>{row.note ?? '—'}</td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      )}
    </Body>
  )
}

// ---- the page -------------------------------------------------------------------------------

export default function Reports() {
  const online = useOnline()
  const [tab, setTab] = useState<Tab>('sales')
  const [preset, setPreset] = useState<Preset | 'custom'>('month')
  const [today] = useState(() => todayInHebron())
  const [custom, setCustom] = useState<Range>(() => presetRange('month', todayInHebron()))
  const range = preset === 'custom' ? custom : presetRange(preset, today)
  const valid = rangeOk(range)

  return (
    <section className="grid gap-4">
      <h2 className="text-2xl font-bold">{ar.reports.title}</h2>
      {!online ? (
        <>
          <OfflineNotice />
          <p>{ar.reports.needsInternet}</p>
        </>
      ) : (
        <>
          <div role="tablist" aria-label={ar.reports.title} className="flex gap-2 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={chip(tab === t)}
              >
                {ar.reports.tabs[t]}
              </button>
            ))}
          </div>

          {HAS_PERIOD.includes(tab) && (
            <div className="grid gap-2 rounded-2xl bg-white p-3">
              <div role="group" aria-label={ar.reports.period} className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={preset === p}
                    onClick={() => setPreset(p)}
                    className={chip(preset === p)}
                  >
                    {ar.reports.presets[p]}
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={preset === 'custom'}
                  onClick={() => {
                    setCustom(range)
                    setPreset('custom')
                  }}
                  className={chip(preset === 'custom')}
                >
                  {ar.reports.presets.custom}
                </button>
              </div>
              {preset === 'custom' && (
                <div className="flex flex-wrap items-end gap-3">
                  {(['from', 'to'] as const).map((side) => (
                    <label key={side} className="grid gap-1">
                      <span>{ar.reports[side]}</span>
                      <input
                        type="date"
                        value={custom[side]}
                        min="2000-01-01"
                        max="2100-12-31"
                        onChange={(e) => setCustom({ ...custom, [side]: e.target.value })}
                        className="min-h-11 rounded-xl border-2 border-navy/30 bg-white px-3"
                      />
                    </label>
                  ))}
                </div>
              )}
              <p className="text-sm opacity-80">
                {fill('{from} → {to}', {
                  from: dayToDisplay(range.from),
                  to: dayToDisplay(range.to),
                })}
              </p>
              {!valid && (
                <p role="alert" className="font-bold">
                  <span aria-hidden="true">⚠ </span>
                  {ar.reports.badRange}
                </p>
              )}
            </div>
          )}

          {HAS_PERIOD.includes(tab) && !valid ? null : tab === 'sales' ? (
            <Sales range={range} />
          ) : tab === 'products' ? (
            <Products range={range} />
          ) : tab === 'collections' ? (
            <Collections range={range} />
          ) : tab === 'balances' ? (
            <Balances />
          ) : tab === 'stock' ? (
            <Stock />
          ) : (
            <Damaged range={range} />
          )}
        </>
      )}
    </section>
  )
}
