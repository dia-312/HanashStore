import { ApiError } from './api'

// Sending an invoice or a statement (SPEC section 11). Online the server's PDF is used; offline the
// same page is drawn on the device and saved as a PNG. On iOS the share sheet needs a fresh tap, so
// the flow is two taps: prepare the file, then share it.

export interface Prepared {
  file: File
  kind: 'pdf' | 'png'
  /** Object URL for the preview; the caller releases it with `URL.revokeObjectURL`. */
  url: string
  ms: number
}

/** Fraction of pixels that are not near-white: about zero means the library returned a blank
 * picture, a known Safari failure (M0 spike). */
async function inkRatio(blob: Blob): Promise<number> {
  const bitmap = await createImageBitmap(blob)
  const width = 200
  const height = Math.max(1, Math.round((bitmap.height / bitmap.width) * width))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return 1 // cannot check: trust the picture
  context.drawImage(bitmap, 0, 0, width, height)
  const data = context.getImageData(0, 0, width, height).data
  let ink = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! < 235 || data[i + 1]! < 235 || data[i + 2]! < 235) ink++
  }
  return ink / (width * height)
}

export class BlankImageError extends Error {
  constructor() {
    super('BLANK_IMAGE')
  }
}

/** The page on screen to a PNG at 2x, with its fonts inlined so no network is needed. */
export async function renderPng(node: HTMLElement, name: string): Promise<Prepared> {
  const started = performance.now()
  const { toBlob, getFontEmbedCSS } = await import('html-to-image') // loaded only when sharing
  await document.fonts.load('400 14px "Plex Arabic"')
  await document.fonts.load('700 14px "Plex Arabic"')
  await document.fonts.ready
  const fontEmbedCSS = await getFontEmbedCSS(node)
  const options = { pixelRatio: 2, fontEmbedCSS, backgroundColor: '#ffffff', cacheBust: false }
  await toBlob(node, options) // warm-up: the first call on Safari can come back blank or unstyled
  const blob = await toBlob(node, options)
  if (!blob || (await inkRatio(blob)) < 0.01) throw new BlankImageError()
  const file = new File([blob], name, { type: 'image/png' })
  return {
    file,
    kind: 'png',
    url: URL.createObjectURL(file),
    ms: Math.round(performance.now() - started),
  }
}

/** The server's PDF. Needs the network and a document the server already has. */
export async function fetchPdf(path: string, name: string): Promise<Prepared> {
  const started = performance.now()
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, { cache: 'no-store', credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'NETWORK', 'No connection')
  }
  if (!response.ok) throw new ApiError(response.status, 'PDF_FAILED', response.statusText)
  const blob = await response.blob()
  const file = new File([blob], name, { type: 'application/pdf' })
  return {
    file,
    kind: 'pdf',
    url: URL.createObjectURL(file),
    ms: Math.round(performance.now() - started),
  }
}

export type ShareResult = 'shared' | 'dismissed' | 'opened'

/** Opens the share sheet. When files can't be shared, opens the file in a new tab instead. */
export async function shareFile(file: File): Promise<ShareResult> {
  const data = { files: [file], title: file.name }
  if (typeof navigator.share === 'function' && navigator.canShare?.(data)) {
    try {
      await navigator.share(data)
      return 'shared'
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'dismissed'
      throw e
    }
  }
  window.open(URL.createObjectURL(file), '_blank')
  return 'opened'
}
