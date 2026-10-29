import { toBlob, getFontEmbedCSS } from 'html-to-image'

export const PNG_NAME = 'INV-000042.png'
export const PDF_NAME = 'INV-000042.pdf'

export interface Capabilities { share: boolean; canSharePdf: boolean; canSharePng: boolean }

export function capabilities(): Capabilities {
  const probe = (name: string, type: string) => {
    try { return !!navigator.canShare?.({ files: [new File([new Uint8Array([0])], name, { type })] }) } catch { return false }
  }
  return {
    share: typeof navigator.share === 'function',
    canSharePdf: probe('probe.pdf', 'application/pdf'),
    canSharePng: probe('probe.png', 'image/png'),
  }
}

/** Fraction of pixels that are not near-white; ~0 means html-to-image returned a blank image (known Safari failure). */
async function inkRatio(blob: Blob): Promise<number> {
  const bmp = await createImageBitmap(blob)
  const w = 200
  const h = Math.max(1, Math.round((bmp.height / bmp.width) * w))
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')!
  ctx.drawImage(bmp, 0, 0, w, h)
  const d = ctx.getImageData(0, 0, w, h).data
  let ink = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) ink++
  return ink / (w * h)
}

export interface PngResult { file: File; ms: number; bytes: number; width: number; height: number; ink: number }

/** Offline path: invoice DOM -> PNG at 2x. Fonts are inlined from the cached woff2 so no network is needed. */
export async function renderInvoicePng(node: HTMLElement): Promise<PngResult> {
  const t0 = performance.now()
  await document.fonts.load('400 14px "Plex Arabic"')
  await document.fonts.load('700 14px "Plex Arabic"')
  await document.fonts.ready
  const fontEmbedCSS = await getFontEmbedCSS(node)
  const opts = { pixelRatio: 2, fontEmbedCSS, backgroundColor: '#ffffff', cacheBust: false }
  await toBlob(node, opts) // warm-up: the first call on Safari can come back blank or unstyled
  const blob = await toBlob(node, opts)
  if (!blob) throw new Error('html-to-image returned null')
  const ink = await inkRatio(blob)
  if (ink < 0.01) throw new Error(`PNG looks blank (ink ${(ink * 100).toFixed(2)}%)`)
  const bmp = await createImageBitmap(blob)
  return {
    file: new File([blob], PNG_NAME, { type: 'image/png' }),
    ms: Math.round(performance.now() - t0),
    bytes: blob.size,
    width: bmp.width,
    height: bmp.height,
    ink,
  }
}

/** Online path: server-rendered PDF (WeasyPrint). */
export async function fetchInvoicePdf(): Promise<{ file: File; ms: number; serverMs: string | null }> {
  const t0 = performance.now()
  const res = await fetch('/api/spike/invoice.pdf', { cache: 'no-store' })
  if (!res.ok) throw new Error(`PDF request failed: HTTP ${res.status}`)
  const blob = await res.blob()
  return {
    file: new File([blob], PDF_NAME, { type: 'application/pdf' }),
    ms: Math.round(performance.now() - t0),
    serverMs: res.headers.get('X-Render-Ms'),
  }
}

/** Opens the share sheet. Falls back to opening the file in a new tab when files can't be shared (SPEC section 11). */
export async function shareFile(file: File): Promise<string> {
  const data = { files: [file], title: file.name }
  if (navigator.share && navigator.canShare?.(data)) {
    try {
      await navigator.share(data)
      return 'share sheet completed'
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'share sheet dismissed'
      throw e
    }
  }
  window.open(URL.createObjectURL(file), '_blank')
  return 'canShare(files) is false -> opened in a new tab'
}
