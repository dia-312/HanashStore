import { useState } from 'react'
import { ConfirmSheet } from '../../components/ConfirmSheet'
import { ErrorNotice } from '../../components/Notices'
import { Thumb } from '../../components/Thumb'
import { ar } from '../../i18n/ar'
import { catalogApi, type ProductImage } from '../../lib/catalogApi'
import { describeError } from '../../lib/errors'

const button = 'min-h-11 rounded-xl border-2 border-navy/30 bg-white px-3 text-sm font-bold'

export function ImagesSection({
  productId,
  images,
  onChange,
}: {
  productId: string
  images: ProductImage[]
  onChange: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ProductImage | null>(null)

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await onChange()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    await run(async () => {
      for (const file of Array.from(files)) await catalogApi.uploadImage(productId, file)
    })
  }

  return (
    <section className="grid gap-3 rounded-2xl bg-white p-4">
      <h3 className="text-lg font-bold">{ar.product.images}</h3>
      {images.length === 0 && <p className="opacity-70">{ar.product.noImages}</p>}
      <ul className="flex gap-3 overflow-x-auto pb-1">
        {images.map((image, index) => (
          <li key={image.id} className="grid w-36 shrink-0 gap-2">
            <Thumb url={image.thumb_url} className="rounded-xl" />
            <div className="flex gap-1">
              <button
                type="button"
                disabled={busy || index === 0}
                aria-label={ar.product.earlier}
                onClick={() => run(() => catalogApi.moveImage(productId, image.id, index - 1))}
                className={button}
              >
                →
              </button>
              <button
                type="button"
                disabled={busy || index === images.length - 1}
                aria-label={ar.product.later}
                onClick={() => run(() => catalogApi.moveImage(productId, image.id, index + 1))}
                className={button}
              >
                ←
              </button>
              <button
                type="button"
                disabled={busy}
                aria-label={ar.product.removeImage}
                onClick={() => setRemoving(image)}
                className={button}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && <ErrorNotice message={error} />}
      <label
        className={`inline-flex min-h-12 w-fit cursor-pointer items-center rounded-xl bg-navy px-5 font-bold text-white ${busy ? 'opacity-50' : ''}`}
      >
        {busy ? ar.product.uploading : `+ ${ar.product.addPhoto}`}
        {/* JPEG/PNG/WebP only: with this list iOS converts camera photos from HEIC to JPEG itself. */}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={busy}
          className="sr-only"
          onChange={(e) => {
            void upload(e.target.files)
            e.target.value = ''
          }}
        />
      </label>
      {removing && (
        <ConfirmSheet
          title={ar.product.removeImage}
          confirmLabel={ar.product.removeImage}
          busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={() =>
            run(() => catalogApi.deleteImage(productId, removing.id)).then(() => setRemoving(null))
          }
        />
      )}
    </section>
  )
}
