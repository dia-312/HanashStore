import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { ConfirmSheet } from '../../components/ConfirmSheet'
import { ErrorNotice, OfflineNotice } from '../../components/Notices'
import { ar, fill } from '../../i18n/ar'
import { catalogApi, type Category } from '../../lib/catalogApi'
import { describeError } from '../../lib/errors'
import { useOnline } from '../../lib/online'
import { syncNow } from '../../lib/sync/engine'

const input = 'min-h-12 rounded-xl border-2 border-navy/30 bg-white px-3'
const small = 'min-h-11 rounded-xl border-2 border-navy/30 bg-white px-4 font-bold'

function Row({ category, onChange }: { category: Category; onChange: () => Promise<void> }) {
  const [name, setName] = useState(category.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const patch = async (body: Parameters<typeof catalogApi.patchCategory>[1]) => {
    setBusy(true)
    setError(null)
    try {
      await catalogApi.patchCategory(category.id, body)
      await onChange()
      setConfirming(false)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`grid gap-2 rounded-xl bg-white p-3 ${category.is_active ? '' : 'opacity-60'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={ar.categories.name}
          className={`${input} min-w-40 flex-1`}
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          disabled={busy || name.trim() === '' || name.trim() === category.name}
          onClick={() => patch({ name: name.trim() })}
          className="min-h-11 rounded-xl bg-navy px-4 font-bold text-white disabled:opacity-40"
        >
          {ar.categories.rename}
        </button>
        <button
          type="button"
          onClick={() => (category.is_active ? setConfirming(true) : patch({ is_active: true }))}
          className={small}
        >
          {category.is_active ? ar.categories.deactivate : ar.categories.activate}
        </button>
      </div>
      <p className="text-sm opacity-70">
        {fill(ar.categories.products, { n: category.product_count })}
        {!category.is_active && ` · ${ar.categories.inactive}`}
      </p>
      {error && <ErrorNotice message={error} />}
      {confirming && (
        <ConfirmSheet
          title={ar.categories.deactivate}
          message={fill(ar.categories.deactivateConfirm, { name: category.name })}
          confirmLabel={ar.categories.deactivate}
          busy={busy}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={() => patch({ is_active: false })}
        />
      )}
    </li>
  )
}

export default function Categories() {
  const online = useOnline()
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setCategories(await catalogApi.categories(showInactive))
    void syncNow() // category names and visibility are also kept on the device
  }, [showInactive])

  useEffect(() => {
    if (!online) return
    catalogApi
      .categories(showInactive)
      .then(setCategories, (e: unknown) => setError(describeError(e)))
  }, [online, showInactive])

  const add = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await catalogApi.createCategory(name.trim())
      setName('')
      await reload()
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
      <h2 className="text-2xl font-bold">{ar.categories.title}</h2>
      {!online ? (
        <OfflineNotice />
      ) : (
        <>
          <form onSubmit={add} className="flex flex-wrap gap-2">
            <input
              aria-label={ar.categories.name}
              placeholder={ar.categories.name}
              className={`${input} min-w-40 flex-1`}
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="submit"
              disabled={busy || name.trim() === ''}
              className="min-h-12 rounded-xl bg-navy px-5 font-bold text-white disabled:opacity-40"
            >
              + {ar.categories.add}
            </button>
          </form>
          {error && <ErrorNotice message={error} />}
          {categories?.length === 0 && <p className="opacity-70">{ar.categories.empty}</p>}
          <ul className="grid gap-2">
            {categories?.map((c) => (
              <Row key={`${c.id}:${c.name}:${c.is_active}`} category={c} onChange={reload} />
            ))}
          </ul>
          <label className="flex min-h-11 items-center gap-2 font-bold">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="size-5"
            />
            {ar.categories.showInactive}
          </label>
        </>
      )}
    </section>
  )
}
