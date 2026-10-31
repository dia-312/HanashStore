import { api } from './api'

// Shapes of the M2 REST API (apps/api/app/schemas.py). Money is integer agorot.

export type StockStatus = 'ok' | 'low' | 'out'

export interface Category {
  id: string
  name: string
  sort_order: number
  is_active: boolean
  product_count: number
}

export interface ProductListItem {
  id: string
  name: string
  category_id: string
  category_name: string
  is_active: boolean
  thumb_url: string | null
  variant_count: number
  price_min: number | null
  price_max: number | null
  stock_total: number
  low_count: number
  out_count: number
}

export interface Variant {
  id: string
  product_id: string
  sku: string
  color: string | null
  size: string | null
  price: number
  min_stock: number
  stock_qty: number
  is_active: boolean
  status: StockStatus
}

export interface ProductImage {
  id: string
  product_id: string
  variant_id: string | null
  thumb_url: string
  full_url: string
  sort_order: number
}

export interface ProductDetail {
  id: string
  name: string
  category_id: string
  category_name: string
  description: string | null
  is_active: boolean
  images: ProductImage[]
  variants: Variant[]
}

export interface VariantListItem {
  id: string
  product_id: string
  product_name: string
  sku: string
  color: string | null
  size: string | null
  price: number
  min_stock: number
  stock_qty: number
  status: StockStatus
  thumb_url: string | null
}

export interface Movement {
  id: string
  qty: number
  type: string
  note: string | null
  created_at: string
  running_total: number
}

export interface Page<T> {
  items: T[]
  next_cursor: string | null
}

export interface RowIssue {
  row: number
  field: string
  code: string
  detail: string | null
}

export interface ImportReport {
  dry_run: boolean
  committed: boolean
  rows: number
  mapped_columns: Record<string, string>
  ignored_columns: string[]
  errors: RowIssue[]
  errors_total: number
  new_categories: number
  new_products: number
  new_variants: number
  skipped_existing: number
  opening_units: number
  preview: {
    row: number
    product: string
    category: string
    color: string | null
    size: string | null
    price: number
    qty: number
  }[]
}

const query = (params: Record<string, string | number | boolean | null | undefined>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const catalogApi = {
  categories: (includeInactive = false) =>
    api<Category[]>(`/categories${query({ include_inactive: includeInactive })}`),
  createCategory: (name: string) =>
    api<Category>('/categories', { method: 'POST', body: { name } }),
  patchCategory: (id: string, body: Partial<Pick<Category, 'name' | 'is_active'>>) =>
    api<Category>(`/categories/${id}`, { method: 'PATCH', body }),

  createProduct: (body: { name: string; category_id: string; description?: string | null }) =>
    api<ProductDetail>('/products', { method: 'POST', body }),
  patchProduct: (
    id: string,
    body: { name?: string; category_id?: string; description?: string | null; is_active?: boolean },
  ) => api<ProductDetail>(`/products/${id}`, { method: 'PATCH', body }),

  createVariant: (
    productId: string,
    body: {
      color: string | null
      size: string | null
      price: number
      min_stock: number
      opening_qty: number
    },
  ) => api<Variant>(`/products/${productId}/variants`, { method: 'POST', body }),
  patchVariant: (
    id: string,
    body: Partial<Pick<Variant, 'price' | 'min_stock' | 'is_active' | 'color' | 'size'>>,
  ) => api<Variant>(`/variants/${id}`, { method: 'PATCH', body }),
  movements: (variantId: string, cursor?: string | null) =>
    api<Page<Movement>>(`/variants/${variantId}/movements${query({ cursor })}`),

  uploadImage: (productId: string, file: File) => {
    const body = new FormData()
    body.append('file', file)
    return api<ProductImage>(`/products/${productId}/images`, { method: 'POST', body })
  },
  moveImage: (productId: string, imageId: string, position: number) =>
    api<ProductImage[]>(`/products/${productId}/images/${imageId}`, {
      method: 'PATCH',
      body: { position },
    }),
  deleteImage: (productId: string, imageId: string) =>
    api(`/products/${productId}/images/${imageId}`, { method: 'DELETE' }),

  importProducts: (file: File, dryRun: boolean) => {
    const body = new FormData()
    body.append('file', file)
    return api<ImportReport>(`/import/products?dry_run=${dryRun}`, { method: 'POST', body })
  },
}
