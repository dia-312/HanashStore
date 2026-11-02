import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ErrorNotice, OfflineNotice } from '../../components/Notices'
import { ar } from '../../i18n/ar'
import { catalogApi, type SynonymGroup } from '../../lib/catalogApi'
import { describeError } from '../../lib/errors'
import { normalizeArabic } from '../../lib/normalize'
import { useOnline } from '../../lib/online'
import { syncNow } from '../../lib/sync/engine'

// Words that mean the same thing when searching (SPEC section 9): each line is one group, the
// words separated by commas. Saved all at once; the device gets them with the next sync.

interface Row {
  key: string
  id?: string
  text: string
}

const input = 'min-h-12 rounded-xl border-2 border-navy/30 bg-white px-3'
const small = 'min-h-11 rounded-xl border-2 border-navy/30 bg-white px-4 font-bold'

const words = (text: string) =>
  text
    .split(/[,،\n]/)
    .map((w) => w.trim())
    .filter(Boolean)

/** A group is worth keeping with two different words once they are written the way search sees them. */
const distinct = (text: string) => new Set(words(text).map(normalizeArabic).filter(Boolean)).size

const toRows = (groups: SynonymGroup[]): Row[] =>
  groups.map((g) => ({ key: g.id, id: g.id, text: g.terms.join('، ') }))

export default function Synonyms() {
  const online = useOnline()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!online) return
    catalogApi.synonyms().then(
      (groups) => setRows(toRows(groups)),
      (e: unknown) => setError(describeError(e)),
    )
  }, [online])

  const edit = (key: string, text: string) => {
    setSaved(false)
    setRows((all) => all?.map((r) => (r.key === key ? { ...r, text } : r)) ?? null)
  }
  const add = () => {
    setSaved(false)
    setRows((all) => [...(all ?? []), { key: crypto.randomUUID(), text: '' }])
  }
  const remove = (key: string) => {
    setSaved(false)
    setRows((all) => all?.filter((r) => r.key !== key) ?? null)
  }

  // A line left empty is just dropped when saving; a line with fewer than two words is a mistake.
  const filled = (rows ?? []).filter((r) => r.text.trim() !== '')
  const invalid = filled.filter((r) => distinct(r.text) < 2).map((r) => r.key)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await catalogApi.saveSynonyms(
        filled.map((r) => ({ id: r.id, terms: words(r.text) })),
      )
      setRows(toRows(result))
      setSaved(true)
      void syncNow()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="grid max-w-2xl gap-4">
      <Link to="/settings" className="inline-flex min-h-11 w-fit items-center font-bold underline">
        → {ar.settings.title}
      </Link>
      <h2 className="text-2xl font-bold">{ar.synonyms.title}</h2>
      <p>{ar.synonyms.hint}</p>
      {!online && <OfflineNotice />}
      {error && <ErrorNotice message={error} />}
      {rows === null ? (
        online && !error && <p aria-busy="true">{ar.common.loading}</p>
      ) : (
        <>
          {rows.length === 0 && <p className="opacity-70">{ar.synonyms.empty}</p>}
          <ul className="grid gap-3">
            {rows.map((row) => (
              <li key={row.key} className="grid gap-2 rounded-xl bg-white p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    aria-label={ar.synonyms.words}
                    aria-invalid={invalid.includes(row.key)}
                    className={`${input} min-w-40 flex-1`}
                    value={row.text}
                    maxLength={400}
                    onChange={(e) => edit(row.key, e.target.value)}
                  />
                  <button type="button" onClick={() => remove(row.key)} className={small}>
                    {ar.synonyms.remove}
                  </button>
                </div>
                {invalid.includes(row.key) && (
                  <p role="alert" className="text-sm font-bold">
                    <span aria-hidden="true">⚠ </span>
                    {ar.synonyms.needTwo}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={add} className={small}>
              + {ar.synonyms.add}
            </button>
            <button
              type="button"
              disabled={busy || !online || invalid.length > 0}
              onClick={() => void save()}
              className="min-h-12 rounded-xl bg-navy px-6 font-bold text-white disabled:opacity-40"
            >
              {ar.synonyms.save}
            </button>
            {saved && (
              <span role="status" className="font-bold">
                <span aria-hidden="true">✓ </span>
                {ar.synonyms.saved}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  )
}
