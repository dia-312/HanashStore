import { useState } from 'react'
import { Link } from 'react-router'
import { ErrorNotice, OfflineNotice } from '../../components/Notices'
import { ApiError } from '../../lib/api'
import { ar, fill } from '../../i18n/ar'
import { catalogApi, type ImportReport, type RowIssue } from '../../lib/catalogApi'
import { describeError } from '../../lib/errors'
import { formatMoney } from '../../lib/money'
import { useOnline } from '../../lib/online'
import { syncNow } from '../../lib/sync/engine'

const FIELDS = ar.importer.fields as Record<string, string>
const CODES = ar.importer.codes as Record<string, string>

export function issueText(issue: RowIssue): string {
  const template = CODES[issue.code] ?? issue.code
  const text = fill(template, { detail: issue.detail ?? '' })
  return issue.code === 'MISSING_COLUMN' ? `${FIELDS[issue.field] ?? issue.field}: ${text}` : text
}

function Summary({ report }: { report: ImportReport }) {
  const rows: [string, number][] = [
    [ar.importer.rows, report.rows],
    [ar.importer.newVariants, report.new_variants],
    [ar.importer.newProducts, report.new_products],
    [ar.importer.newCategories, report.new_categories],
    [ar.importer.skipped, report.skipped_existing],
    [ar.importer.units, report.opening_units],
  ]
  return (
    <dl className="grid gap-2 rounded-2xl bg-white p-4">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4">
          <dt>{label}</dt>
          <dd className="font-bold">
            <bdi>{value}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  )
}

export default function ImportProducts() {
  const online = useOnline()
  const [file, setFile] = useState<File | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [done, setDone] = useState<ImportReport | null>(null)
  const [busy, setBusy] = useState<'checking' | 'importing' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setFile(null)
    setReport(null)
    setDone(null)
    setError(null)
  }

  const check = async (chosen: File) => {
    setFile(chosen)
    setReport(null)
    setError(null)
    setBusy('checking')
    try {
      setReport(await catalogApi.importProducts(chosen, true))
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(null)
    }
  }

  const start = async () => {
    if (!file) return
    setBusy('importing')
    setError(null)
    try {
      setDone(await catalogApi.importProducts(file, false))
      void syncNow() // bring the imported products onto this device
    } catch (e) {
      if (e instanceof ApiError && e.code === 'IMPORT_HAS_ERRORS')
        setReport(e.details as unknown as ImportReport)
      else setError(describeError(e))
    } finally {
      setBusy(null)
    }
  }

  const canStart = report !== null && report.errors_total === 0 && report.new_variants > 0

  return (
    <section className="grid max-w-3xl gap-4">
      <Link to="/settings" className="inline-flex min-h-11 w-fit items-center font-bold underline">
        → {ar.settings.title}
      </Link>
      <h2 className="text-2xl font-bold">{ar.importer.title}</h2>
      {!online ? (
        <OfflineNotice />
      ) : done ? (
        <div role="status" className="grid gap-3">
          <h3 className="text-xl font-bold">
            <span aria-hidden="true">✓ </span>
            {ar.importer.doneTitle}
          </h3>
          <Summary report={done} />
          <div className="flex flex-wrap gap-3">
            <Link
              to="/catalog"
              className="inline-flex min-h-12 items-center rounded-xl bg-navy px-6 font-bold text-white"
            >
              {ar.nav.catalog}
            </Link>
            <button
              type="button"
              onClick={reset}
              className="min-h-12 rounded-xl border-2 border-navy/30 bg-white px-6 font-bold"
            >
              {ar.importer.again}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p>{ar.importer.hint}</p>
          <label className="inline-flex min-h-12 w-fit cursor-pointer items-center rounded-xl bg-navy px-6 font-bold text-white">
            {ar.importer.choose}
            <input
              type="file"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              disabled={busy !== null}
              onChange={(e) => {
                const chosen = e.target.files?.[0]
                e.target.value = ''
                if (chosen) void check(chosen)
              }}
            />
          </label>
          {file && <p className="text-sm opacity-70">{file.name}</p>}
          {busy === 'checking' && <p aria-busy="true">{ar.importer.checking}</p>}
          {error && <ErrorNotice message={error} />}
          {report && (
            <>
              <h3 className="text-lg font-bold">{ar.importer.summary}</h3>
              <Summary report={report} />
              {report.ignored_columns.length > 0 && (
                <p className="text-sm">
                  {fill(ar.importer.ignoredColumns, { list: report.ignored_columns.join('، ') })}
                </p>
              )}
              {report.errors_total > 0 && (
                <div className="grid gap-2 rounded-2xl border-2 border-red-700 bg-white p-4">
                  <h3 className="font-bold text-red-700">
                    <span aria-hidden="true">⚠ </span>
                    {fill(ar.importer.errorsTitle, { n: report.errors_total })}
                  </h3>
                  <p className="text-sm">{ar.importer.errorsHint}</p>
                  <ul className="grid gap-1">
                    {report.errors.map((issue, i) => (
                      <li key={i}>
                        <span className="font-bold">
                          {fill(ar.importer.rowLabel, { n: issue.row })}
                        </span>
                        {issue.code === 'MISSING_COLUMN'
                          ? ' — '
                          : ` — ${FIELDS[issue.field] ?? issue.field}: `}
                        {issueText(issue)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {report.preview.length > 0 && (
                <div className="overflow-x-auto rounded-2xl bg-white p-4">
                  <h3 className="mb-2 font-bold">{ar.importer.previewTitle}</h3>
                  <table className="w-full min-w-120 text-start">
                    <thead>
                      <tr className="text-start">
                        <th className="text-start">{FIELDS.product}</th>
                        <th className="text-start">{FIELDS.category}</th>
                        <th className="text-start">{FIELDS.color}</th>
                        <th className="text-start">{FIELDS.size}</th>
                        <th className="text-start">{FIELDS.price}</th>
                        <th className="text-start">{FIELDS.qty}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.preview.map((p) => (
                        <tr key={p.row} className="border-t border-navy/10">
                          <td>{p.product}</td>
                          <td>{p.category}</td>
                          <td>{p.color ?? '—'}</td>
                          <td>{p.size ?? '—'}</td>
                          <td>
                            <bdi>{formatMoney(p.price)}</bdi>
                          </td>
                          <td>
                            <bdi>{p.qty}</bdi>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {report.errors_total === 0 && report.new_variants === 0 && (
                <p className="font-bold">{ar.importer.nothingNew}</p>
              )}
              <button
                type="button"
                disabled={!canStart || busy !== null}
                onClick={start}
                className="min-h-12 w-fit rounded-xl bg-navy px-8 font-bold text-white disabled:opacity-40"
              >
                {busy === 'importing' ? ar.importer.importing : ar.importer.start}
              </button>
            </>
          )}
        </>
      )}
    </section>
  )
}
