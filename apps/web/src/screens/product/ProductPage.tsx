import { useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ConfirmSheet } from '../../components/ConfirmSheet'
import { ErrorNotice, OfflineNotice } from '../../components/Notices'
import { db } from '../../db'
import { ar, fill } from '../../i18n/ar'
import { catalogApi, type Category, type ProductDetail } from '../../lib/catalogApi'
import { describeError } from '../../lib/errors'
import { buildProductDetail, loadProductSnapshot } from '../../lib/localCatalog'
import { useOnline } from '../../lib/online'
import { syncNow } from '../../lib/sync/engine'
import { useSyncOnOpen } from '../../lib/sync/useSyncOnOpen'
import { useLive } from '../../lib/useLive'
import { ImagesSection } from './ImagesSection'
import { VariantsSection } from './VariantsSection'

const input = 'min-h-12 w-full rounded-xl border-2 border-navy/30 bg-white px-3'

/** Active categories from the device. */
function useCategories() {
  const rows = useLive(() => db.categories.toArray(), [])
  return useMemo<Category[] | null>(
    () => rows?.filter((c) => c.is_active).map((c) => ({ ...c, product_count: 0 })) ?? null,
    [rows],
  )
}

/** After an online edit the server's answer comes back through a pull, so the screen, which reads
 * the device, shows it as soon as that lands. */
const refresh = async () => {
  await syncNow()
}

/** Name, category and description. Used to create a product and to edit one. */
function InfoForm({
  product,
  categories,
  onSaved,
}: {
  product: ProductDetail | null
  categories: Category[]
  onSaved: (saved: ProductDetail) => void
}) {
  const [name, setName] = useState(product?.name ?? '')
  const [categoryId, setCategoryId] = useState(product?.category_id ?? '')
  const [description, setDescription] = useState(product?.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // A deactivated product's category may be hidden from the active list: keep it selectable.
  const options =
    product && !categories.some((c) => c.id === product.category_id)
      ? [{ id: product.category_id, name: product.category_name } as Category, ...categories]
      : categories
  const ready = name.trim() !== '' && categoryId !== ''

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const body = {
        name: name.trim(),
        category_id: categoryId,
        description: description.trim() || null,
      }
      const result = product
        ? await catalogApi.patchProduct(product.id, body)
        : await catalogApi.createProduct(body)
      await refresh() // the device must hold the product before the screen opens it
      setSaved(true)
      onSaved(result)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-2xl bg-white p-4">
      <label className="grid gap-1">
        <span className="font-bold">{ar.product.name}</span>
        <input
          className={input}
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="grid gap-1">
        <span className="font-bold">{ar.product.category}</span>
        <select
          className={input}
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">{ar.product.chooseCategory}</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {options.length === 0 && (
          <span className="text-sm">
            {ar.product.noCategories}{' '}
            <Link to="/settings/categories" className="font-bold underline">
              {ar.categories.title}
            </Link>
          </span>
        )}
      </label>
      <label className="grid gap-1">
        <span className="font-bold">{ar.product.description}</span>
        <textarea
          className={`${input} min-h-24 py-2`}
          value={description}
          maxLength={2000}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {error && <ErrorNotice message={error} />}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!ready || busy}
          className="min-h-12 rounded-xl bg-navy px-6 font-bold text-white disabled:opacity-40"
        >
          {busy ? ar.form.saving : product ? ar.form.save : ar.product.create}
        </button>
        {saved && product && (
          <span role="status" className="font-bold">
            <span aria-hidden="true">✓ </span>
            {ar.form.saved}
          </span>
        )}
      </div>
    </form>
  )
}

function NewProduct() {
  const navigate = useNavigate()
  const categories = useCategories()
  if (categories === null) return <p aria-busy="true">{ar.common.loading}</p>
  return (
    <InfoForm
      product={null}
      categories={categories}
      onSaved={(created) => navigate(`/catalog/${created.id}`, { replace: true })}
    />
  )
}

function ExistingProduct({ id }: { id: string }) {
  const categories = useCategories()
  // undefined while the device is being read, null when it has no such product.
  const product = useLive(async () => buildProductDetail(await loadProductSnapshot(id), id), [id])
  const [failed, setFailed] = useState<string | null>(null)
  const [deactivating, setDeactivating] = useState(false)
  const [busy, setBusy] = useState(false)

  const setActive = async (active: boolean) => {
    setBusy(true)
    try {
      await catalogApi.patchProduct(id, { is_active: active })
      await refresh()
      setDeactivating(false)
    } catch (e) {
      setFailed(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  if (product === null) return <p className="text-lg font-bold">{ar.product.notFound}</p>
  if (failed) return <ErrorNotice message={failed} />
  if (!product || categories === null) return <p aria-busy="true">{ar.common.loading}</p>

  return (
    <div className="grid max-w-4xl gap-4">
      <h2 className="text-2xl font-bold">
        {product.name}{' '}
        {!product.is_active && <span className="text-base">({ar.catalog.inactive})</span>}
      </h2>
      <InfoForm
        key={product.id}
        product={product}
        categories={categories}
        onSaved={() => undefined}
      />
      <ImagesSection productId={product.id} images={product.images} onChange={refresh} />
      <VariantsSection productId={product.id} variants={product.variants} onChange={refresh} />
      <div>
        <button
          type="button"
          onClick={() => (product.is_active ? setDeactivating(true) : setActive(true))}
          className="min-h-12 rounded-xl border-2 border-navy/30 bg-white px-6 font-bold"
        >
          {product.is_active ? ar.product.deactivateProduct : ar.product.activateProduct}
        </button>
      </div>
      {deactivating && (
        <ConfirmSheet
          title={ar.product.deactivateProduct}
          message={fill(ar.product.deactivateConfirm, { name: product.name })}
          confirmLabel={ar.product.deactivateProduct}
          busy={busy}
          onCancel={() => setDeactivating(false)}
          onConfirm={() => setActive(false)}
        />
      )}
    </div>
  )
}

export default function ProductPage() {
  const { productId = '' } = useParams()
  const online = useOnline()
  useSyncOnOpen()
  return (
    <section className="grid gap-4">
      <Link to="/catalog" className="inline-flex min-h-11 w-fit items-center font-bold underline">
        ← {ar.product.back}
      </Link>
      {productId === 'new' ? (
        !online ? (
          <OfflineNotice />
        ) : (
          <>
            <h2 className="text-2xl font-bold">{ar.product.newTitle}</h2>
            <NewProduct />
          </>
        )
      ) : (
        <>
          {/* Looking works offline; changing products and photos needs the server. */}
          {!online && (
            <p
              role="status"
              className="rounded-xl border-2 border-dashed border-navy/40 p-3 font-bold"
            >
              <span aria-hidden="true">○ </span>
              {ar.catalog.editNeedsInternet}
            </p>
          )}
          <ExistingProduct key={productId} id={productId} />
        </>
      )}
    </section>
  )
}
