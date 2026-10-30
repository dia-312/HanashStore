import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { clientsClaim } from 'workbox-core'

// Module-scoped, loosely typed `self`: one tsconfig serves both the app (DOM lib) and this worker.
// The literal `self.__WB_MANIFEST` below is what Workbox replaces at build time, so it must not be aliased.
declare const self: {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>
  skipWaiting(): void
  addEventListener(type: 'message', listener: (event: { data?: { type?: string } }) => void): void
}

// A new version waits until the rep taps "update" (or the app is closed and opened again): it must
// never take over in the middle of a cart or a checkout (SPEC section 8).
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})
clientsClaim()

// App shell: hashed build output, precached so the app opens offline from a cold start.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// SPA navigations are answered from the precached index.html (never the network).
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }),
)

// Thumbnails and the variants file: same-origin responses, cached on first use (SPEC section 3, images row).
registerRoute(
  ({ url }) => url.pathname.startsWith('/media/'),
  new CacheFirst({ cacheName: 'media' }),
)

// /api/* is intentionally not cached: the PDF is an online-only path.
