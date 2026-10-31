import { create } from 'zustand'

interface UpdateState {
  /** A new version is downloaded and waiting. */
  available: boolean
  /** Activates it and reloads. Set by main.tsx once the service worker is registered. */
  apply: () => void
}

/** The new version is offered, never forced: reloading in the middle of a cart or a checkout would
 * lose work (SPEC section 8). If the rep ignores it, it takes over at the next cold start. */
export const useUpdate = create<UpdateState>()(() => ({ available: false, apply: () => undefined }))
