import { useEffect, useRef, useState } from 'react'
import { ar, fill } from '../i18n/ar'
import type { InvoiceDoc, StatementDoc } from '../lib/documents'
import { useOnline } from '../lib/online'
import {
  BlankImageError,
  fetchPdf,
  renderPng,
  shareFile,
  type Prepared,
  type ShareResult,
} from '../lib/share'
import { InvoiceDocument } from './InvoiceDocument'
import { StatementDocument } from './StatementDocument'

export type ShareDoc =
  { type: 'invoice'; data: InvoiceDoc } | { type: 'statement'; data: StatementDoc }

const button =
  'min-h-12 rounded-xl border-2 border-navy/30 bg-white px-5 font-bold disabled:opacity-40'
const primary = 'min-h-12 rounded-xl bg-navy px-6 font-bold text-white disabled:opacity-40'

/**
 * Prepare, then share (SPEC section 11). Online the PDF comes from the server; the picture is
 * drawn here from the same page layout, so it works with no network and for an invoice the server
 * has not received yet. Sharing is a second tap because iOS wants a fresh one.
 */
export default function SharePanel({
  doc,
  fileBase,
  pdfPath,
  pdfBlocked,
  tall = false,
}: {
  doc: ShareDoc
  /** File name without its extension, e.g. `INV-000042`. */
  fileBase: string
  /** Where the server renders the PDF, or null when it can't (not on the server yet). */
  pdfPath: string | null
  /** Why a PDF is not possible, shown next to the image button. */
  pdfBlocked?: string
  /** A long statement makes a tall picture: say so. */
  tall?: boolean
}) {
  const online = useOnline()
  const page = useRef<HTMLDivElement>(null)
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Release the preview's memory when it is replaced or the panel goes away.
  useEffect(() => () => (prepared ? URL.revokeObjectURL(prepared.url) : undefined), [prepared])

  const canPdf = online && pdfPath !== null
  const reason = !canPdf ? (pdfPath === null ? pdfBlocked : ar.share.pdfNeedsInternet) : undefined

  const prepare = async (kind: 'pdf' | 'png') => {
    setBusy(true)
    setMessage(null)
    setError(null)
    setPrepared(null)
    try {
      const next =
        kind === 'pdf' && pdfPath
          ? await fetchPdf(pdfPath, `${fileBase}.pdf`)
          : await renderPng(page.current!, `${fileBase}.png`)
      setPrepared(next)
    } catch (e) {
      setError(e instanceof BlankImageError ? ar.share.blank : ar.share.failed)
    } finally {
      setBusy(false)
    }
  }

  const share = async () => {
    if (!prepared) return
    setError(null)
    try {
      const result: ShareResult = await shareFile(prepared.file)
      setMessage(ar.share[result])
    } catch {
      setError(ar.share.failed)
    }
  }

  return (
    <section className="grid gap-3 rounded-2xl bg-white p-4">
      <h3 className="text-lg font-bold">{ar.share.title}</h3>
      <p className="text-sm opacity-80">{ar.share.hint}</p>
      {tall && !canPdf && <p className="text-sm font-bold">{ar.share.tall}</p>}
      <div className="flex flex-wrap gap-2">
        {canPdf && (
          <button
            type="button"
            className={primary}
            disabled={busy}
            onClick={() => void prepare('pdf')}
          >
            {ar.share.preparePdf}
          </button>
        )}
        <button
          type="button"
          className={canPdf ? button : primary}
          disabled={busy}
          onClick={() => void prepare('png')}
        >
          {ar.share.preparePng}
        </button>
      </div>
      {reason && <p className="text-sm">{reason}</p>}
      {busy && (
        <p role="status" aria-busy="true">
          {ar.share.preparing}
        </p>
      )}
      {prepared && (
        <div className="grid gap-2 rounded-xl border-2 border-navy/15 p-3">
          <p role="status" className="font-bold">
            <span aria-hidden="true">✓ </span>
            {fill(ar.share.ready, { name: prepared.file.name })}{' '}
            <span className="text-sm font-normal opacity-70">
              <bdi>
                {Math.round(prepared.file.size / 1024)} KB ·{' '}
                {fill(ar.share.took, { ms: prepared.ms })}
              </bdi>
            </span>
          </p>
          {prepared.kind === 'png' && (
            <img
              src={prepared.url}
              alt={ar.share.preview}
              className="max-h-96 w-fit max-w-full rounded-lg border border-navy/20 bg-white"
            />
          )}
          <button type="button" className={primary} onClick={() => void share()}>
            {ar.share.share}
          </button>
        </div>
      )}
      {message && (
        <p role="status" className="font-bold">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="font-bold text-red-700">
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      )}

      {/* The page the picture is made from: drawn off screen, never shown. */}
      <div aria-hidden="true" style={{ position: 'fixed', insetInlineStart: -10000, top: 0 }}>
        {doc.type === 'invoice' ? (
          <InvoiceDocument ref={page} doc={doc.data} />
        ) : (
          <StatementDocument ref={page} doc={doc.data} />
        )}
      </div>
    </section>
  )
}
