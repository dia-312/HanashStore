import { create } from 'zustand'
import { db } from '../../db'

// Every product image, thumbnail and full size, is kept on the device after each pull, because
// presentation mode must show all of them offline (SPEC section 8). The files are same-origin
// /media/ URLs; the service worker's `media` cache is where they live.
export const MEDIA_CACHE = 'media'
export const CONCURRENCY = 4

interface ImageProgress {
  cached: number
  total: number
  running: boolean
}

export const useImages = create<ImageProgress>()(() => ({ cached: 0, total: 0, running: false }))

const hasCaches = () => 'caches' in globalThis

/** Thumbnails first (the catalog needs them at once), then the full-size images. */
export async function expectedUrls(): Promise<string[]> {
  const activeProducts = new Set(await db.products.filter((p) => p.is_active).primaryKeys())
  const images = await db.images
    .filter((i) => i.deleted_at === null && activeProducts.has(i.product_id))
    .toArray()
  return [...new Set([...images.map((i) => i.thumb_url), ...images.map((i) => i.full_url)])]
}

async function cachedPaths(): Promise<Set<string>> {
  if (!hasCaches()) return new Set()
  const cache = await caches.open(MEDIA_CACHE)
  return new Set((await cache.keys()).map((r) => new URL(r.url).pathname))
}

const pathOf = (url: string) => new URL(url, location.origin).pathname

/** How many of the images the catalog needs are on the device, read from the cache itself. */
export async function refreshImageProgress(): Promise<ImageProgress> {
  const urls = await expectedUrls()
  const have = await cachedPaths()
  const cached = urls.filter((u) => have.has(pathOf(u))).length
  useImages.setState({ cached, total: urls.length })
  return useImages.getState()
}

let paused = false
let running: Promise<void> | null = null

/** Checkout pauses downloads so they never compete with the sale (SPEC section 17). */
export function setImagesPaused(value: boolean): void {
  paused = value
}

/** Leaving checkout: carry on with what was left. */
export function resumeImageDownloads(): Promise<void> {
  paused = false
  return runImageQueue()
}

export interface QueueOptions {
  online?: () => boolean
  download?: (url: string) => Promise<void>
}

const defaultDownload = async (url: string) => {
  const cache = await caches.open(MEDIA_CACHE)
  const response = await fetch(url)
  if (response.ok) await cache.put(url, response)
}

/** Downloads what is missing, at most four at a time. Safe to call again: one run at a time. */
export function runImageQueue(options: QueueOptions = {}): Promise<void> {
  if (running) return running
  const online = options.online ?? (() => navigator.onLine)
  const download = options.download ?? defaultDownload
  running = (async () => {
    if (!hasCaches()) return
    useImages.setState({ running: true })
    try {
      const have = await cachedPaths()
      const todo = (await expectedUrls()).filter((u) => !have.has(pathOf(u)))
      let next = 0
      let done = 0
      const worker = async () => {
        while (!paused && online()) {
          const url = todo[next++]
          if (url === undefined) return
          try {
            await download(url)
          } catch {
            // One failed image must not stop the rest; the next run tries it again.
          }
          done++
          if (done % 20 === 0) await refreshImageProgress()
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    } finally {
      await refreshImageProgress()
      useImages.setState({ running: false })
    }
  })().finally(() => {
    running = null
  })
  return running
}

/** Settings button: forget every cached image and fetch them all again. */
export async function redownloadAllImages(): Promise<void> {
  if (hasCaches()) await caches.delete(MEDIA_CACHE)
  await runImageQueue()
}
