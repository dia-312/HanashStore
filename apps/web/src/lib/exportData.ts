import { ApiError } from './api'

// The export (SPEC F13): a ZIP of CSV files made by the server. Two steps, like sending an invoice,
// because iOS only lets a page open the share sheet straight after a tap: first the file is made
// (this takes a moment), then a second tap shares or saves it.

export interface ExportFile {
  file: File
  /** Size in KB, rounded up, for the screen. */
  kb: number
}

const FALLBACK_NAME = 'hanash-export.zip'

export async function prepareExport(): Promise<ExportFile> {
  let response: Response
  try {
    response = await fetch('/api/v1/export', { credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'NETWORK', 'No connection')
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { code?: string } | null
    throw new ApiError(response.status, body?.code ?? 'HTTP_ERROR', response.statusText)
  }
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? FALLBACK_NAME
  const blob = await response.blob()
  const file = new File([blob], name, { type: 'application/zip' })
  return { file, kb: Math.max(1, Math.ceil(file.size / 1024)) }
}

/** Shares the file with the share sheet; where that is not possible, opens it so it can be saved. */
export async function saveExport(
  { file }: ExportFile,
  title: string,
): Promise<'shared' | 'opened' | 'cancelled'> {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title })
      return 'shared'
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
      // any other refusal: fall through to opening it
    }
  }
  const url = URL.createObjectURL(file)
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return 'opened'
}
