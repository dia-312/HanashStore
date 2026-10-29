import { useEffect, useRef, useState } from 'react'
import { InvoiceView } from '../invoice/InvoiceView'
import { capabilities, fetchInvoicePdf, renderInvoicePng, shareFile } from '../share'

export function ShareScreen() {
  const nodeRef = useRef<HTMLDivElement>(null)
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [png, setPng] = useState<{ file: File; url: string } | null>(null)
  const [pdf, setPdf] = useState<File | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const caps = capabilities()

  useEffect(() => {
    const f = () => setOnline(navigator.onLine)
    window.addEventListener('online', f)
    window.addEventListener('offline', f)
    return () => { window.removeEventListener('online', f); window.removeEventListener('offline', f) }
  }, [])

  const say = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString('en-GB')}  ${m}`, ...l].slice(0, 30))
  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn() } catch (e) { say(`${name} FAILED: ${(e as Error).name}: ${(e as Error).message}`) } finally { setBusy(false) }
  }

  const preparePng = async () => {
    const r = await renderInvoicePng(nodeRef.current!)
    setPng((old) => { if (old) URL.revokeObjectURL(old.url); return { file: r.file, url: URL.createObjectURL(r.file) } })
    say(`PNG ready: ${r.width}x${r.height}px, ${(r.bytes / 1024).toFixed(0)} KB, ink ${(r.ink * 100).toFixed(1)}%, ${r.ms} ms`)
    return r.file
  }
  const preparePdf = async () => {
    const r = await fetchInvoicePdf()
    setPdf(r.file)
    say(`PDF ready: ${(r.file.size / 1024).toFixed(0)} KB, ${r.ms} ms round trip, server render ${r.serverMs ?? '?'} ms`)
    return r.file
  }

  const btn = 'min-h-11 rounded-lg px-4 font-bold text-white disabled:opacity-40'
  return (
    <div className="h-full overflow-auto p-4">
      <h1 className="mb-1 text-xl font-bold">C · Invoice sharing</h1>
      <p className="mb-3 text-sm text-slate-600">
        PNG works offline (rendered on the device). PDF needs the server. Each can be shared in one tap or prepared first; a prepared file shares inside a fresh tap, which is the safest path on iOS.
      </p>

      <section className="mb-4 rounded-xl bg-white p-3 text-sm shadow-sm">
        <div>Network: <b>{online ? 'online' : 'offline'}</b></div>
        <div dir="ltr" className="text-start">
          navigator.share: <b>{String(caps.share)}</b> · canShare(pdf): <b>{String(caps.canSharePdf)}</b> · canShare(png): <b>{String(caps.canSharePng)}</b>
        </div>
      </section>

      <div className="mb-4 grid grid-cols-2 gap-2">
        <button disabled={busy} className={`${btn} bg-[#14213D]`} onClick={() => run('PNG prepare', async () => { await preparePng() })}>
          1. Prepare PNG (offline OK)
        </button>
        <button disabled={busy || !png} className={`${btn} bg-[#F28C28]`} onClick={() => run('PNG share', async () => say(`PNG: ${await shareFile(png!.file)}`))}>
          2. Share prepared PNG
        </button>
        <button disabled={busy} className={`${btn} bg-[#14213D]`} onClick={() => run('PDF prepare', async () => { await preparePdf() })}>
          1. Prepare PDF (online)
        </button>
        <button disabled={busy || !pdf} className={`${btn} bg-[#F28C28]`} onClick={() => run('PDF share', async () => say(`PDF: ${await shareFile(pdf!)}`))}>
          2. Share prepared PDF
        </button>
        <button disabled={busy} className={`${btn} bg-[#3FA7D6]`} onClick={() => run('PNG one tap', async () => say(`PNG one-tap: ${await shareFile(await preparePng())}`))}>
          Share PNG — one tap
        </button>
        <button disabled={busy} className={`${btn} bg-[#3FA7D6]`} onClick={() => run('PDF one tap', async () => say(`PDF one-tap: ${await shareFile(await preparePdf())}`))}>
          Share PDF — one tap
        </button>
      </div>

      <h2 className="mb-1 font-bold">Log</h2>
      <pre dir="ltr" className="mb-4 min-h-16 whitespace-pre-wrap rounded-xl bg-white p-3 text-xs shadow-sm">{log.join('\n') || '—'}</pre>

      <div className="mb-4 grid gap-4 md:grid-cols-2">
        <div>
          <h2 className="mb-1 font-bold">Rendered PNG (what WhatsApp will receive)</h2>
          {png ? <img src={png.url} alt="rendered invoice" className="w-full rounded-xl border border-black/10 bg-white" /> : <div className="rounded-xl bg-white p-3 text-sm text-slate-500">press “Prepare PNG”</div>}
        </div>
        <div>
          <h2 className="mb-1 font-bold">PDF from the server</h2>
          <a href="/api/spike/invoice.pdf" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-lg bg-white px-4 font-bold shadow-sm">
            Open PDF in a new tab
          </a>
        </div>
      </div>

      {/* Captured by html-to-image. The wrapper is off-screen; the node itself is laid out normally. */}
      <div className="offscreen" aria-hidden="true">
        <InvoiceView ref={nodeRef} />
      </div>
    </div>
  )
}
