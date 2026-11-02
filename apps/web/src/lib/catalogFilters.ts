import { create } from 'zustand'
import type { StockStatus } from './catalogApi'
import type { SortKey } from './localCatalog'

// The catalog's chips and order (SPEC section 9). They stay while the rep opens a product and comes
// back, and go when he clears them or leaves the catalog (Shell calls `reset`).

export interface CatalogFilters {
  categoryId?: string
  includeInactive: boolean
  color?: string
  size?: string
  availability?: StockStatus
  /** Agorot. */
  priceMin?: number
  priceMax?: number
}

interface State extends CatalogFilters {
  sort: SortKey
  set: (changes: Partial<CatalogFilters> & { sort?: SortKey }) => void
  /** Drop the filters; the order stays. */
  clear: () => void
  /** Back to the start: filters and order. */
  reset: () => void
}

const NONE: CatalogFilters = {
  categoryId: undefined,
  includeInactive: false,
  color: undefined,
  size: undefined,
  availability: undefined,
  priceMin: undefined,
  priceMax: undefined,
}

export const useCatalogFilters = create<State>()((set) => ({
  ...NONE,
  sort: 'relevance',
  set: (changes) => set(changes),
  clear: () => set(NONE),
  reset: () => set({ ...NONE, sort: 'relevance' }),
}))

export const resetCatalogFilters = () => useCatalogFilters.getState().reset()

/** How many filters are on, for the button label. Price counts once. */
export function activeFilterCount(f: CatalogFilters): number {
  return [
    f.categoryId !== undefined,
    f.includeInactive,
    f.color !== undefined,
    f.size !== undefined,
    f.availability !== undefined,
    f.priceMin !== undefined || f.priceMax !== undefined,
  ].filter(Boolean).length
}

/** The catalog list and a product page both count as "in the catalog". */
export const isCatalogPath = (pathname: string) =>
  pathname === '/catalog' || pathname.startsWith('/catalog/')
