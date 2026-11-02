// Command types and payloads the device can push (SPEC section 8, apps/api/app/schemas.py).

export const SCHEMA_VERSION = 1

export interface PurchasePayload {
  note: string | null
  items: { movement_id: string; variant_id: string; qty: number }[]
}

export interface DamagePayload {
  movement_id: string
  variant_id: string
  qty: number
  note: string
}

export interface AdjustPayload {
  movement_id: string
  variant_id: string
  counted_qty: number
  /** The quantity the rep saw when counting; the server warns if it has another number. */
  expected_qty: number
  note: string
}

export interface CustomerPayload {
  customer_id: string
  name: string
  shop_name: string | null
  phone: string | null
  area: string | null
  address: string | null
  notes: string | null
  /** Only taken when the customer is created. */
  opening_balance: number
  is_active: boolean
}

export type PaymentMethod = 'cash' | 'transfer' | 'cheque'

export interface InvoiceCreatePayload {
  invoice_id: string
  number: string
  customer_id: string
  issued_at: string
  discount: number
  note: string | null
  payment: {
    payment_id: string
    number: string
    amount: number
    method: PaymentMethod
    note: string | null
  } | null
  lines: { line_id: string; variant_id: string; qty: number; unit_price: number }[]
}

export interface MarkDeliveredPayload {
  invoice_id: string
  delivered_at: string
}

/** The server ignores the last four fields: they let this device show the effect of the command
 * (stock and balance) before the server has answered. */
export interface CancelPayload {
  invoice_id: string
  cancelled_at: string
  reason: string
  void_payment: boolean
  customer_id: string
  /** The invoice total and the active payment linked to it, as this device knows them. */
  total: number
  payment_amount: number
  lines: { variant_id: string; qty: number }[]
}

export interface PaymentCreatePayload {
  payment_id: string
  number: string
  customer_id: string
  paid_at: string
  amount: number
  method: PaymentMethod
  note: string | null
}

/** Money handed back to a customer (a return he had already paid for). */
export interface RefundCreatePayload {
  refund_id: string
  number: string
  customer_id: string
  refunded_at: string
  amount: number
  method: PaymentMethod
  note: string | null
}

/** The server ignores `customer_id`, `amount` and `kind`: they let this device show the new
 * balance at once (voiding a payment raises what he owes, voiding a refund lowers it). */
export interface PaymentVoidPayload {
  payment_id: string
  voided_at: string
  reason: string
  customer_id: string
  amount: number
  kind?: 'payment' | 'refund'
}

export type Disposition = 'restock' | 'damaged'

/** The server works out the amounts itself. `customer_id`, `total` and the `variant_id` and
 * `amount` of each line let this device show the new balance and stock before it answers. */
export interface ReturnCreatePayload {
  return_id: string
  number: string
  invoice_id: string
  issued_at: string
  reason: string | null
  customer_id: string
  total: number
  lines: {
    return_line_id: string
    invoice_line_id: string
    qty: number
    disposition: Disposition
    variant_id: string
    amount: number
  }[]
}

export type CommandType =
  | 'stock.purchase'
  | 'stock.damage'
  | 'stock.adjust'
  | 'customer.upsert'
  | 'invoice.create'
  | 'invoice.mark_delivered'
  | 'invoice.cancel'
  | 'payment.create'
  | 'payment.void'
  | 'refund.create'
  | 'return.create'

export interface CommandResult {
  id: string
  status: 'applied' | 'rejected'
  data?: {
    applied?: number
    variants?: { id: string; stock_qty: number; change_seq: number }[]
    /** The customer's balance after the command, as the server worked it out. */
    customer_id?: string
    customer_balance?: number
  }
  warnings?: { code: string }[]
  error?: { code: string; message: string; details: Record<string, unknown> }
}

export interface PushResponse {
  results: CommandResult[]
  cursor: number
}

/** Variant ids a command touches, so the sync screen can name them. */
export function commandVariantIds(type: string, payload: unknown): string[] {
  switch (type) {
    case 'stock.purchase':
      return (payload as PurchasePayload).items.map((i) => i.variant_id)
    case 'stock.damage':
    case 'stock.adjust':
      return [(payload as DamagePayload | AdjustPayload).variant_id]
    case 'invoice.create':
      return (payload as InvoiceCreatePayload).lines.map((l) => l.variant_id)
    case 'invoice.cancel':
      return (payload as CancelPayload).lines.map((l) => l.variant_id)
    case 'return.create':
      return (payload as ReturnCreatePayload).lines.map((l) => l.variant_id)
    default:
      return []
  }
}

/** What a waiting command does to one variant, for the movement history: a signed quantity for a
 * stock-in, sale or write-off, or the counted quantity for a count. */
export function commandEffectOn(
  type: string,
  payload: unknown,
  variantId: string,
): { type: string; qty: number; counted: boolean } | null {
  if (type === 'stock.purchase') {
    const qty = (payload as PurchasePayload).items
      .filter((i) => i.variant_id === variantId)
      .reduce((sum, i) => sum + i.qty, 0)
    return qty > 0 ? { type, qty, counted: false } : null
  }
  if (type === 'stock.damage') {
    const p = payload as DamagePayload
    return p.variant_id === variantId ? { type, qty: -p.qty, counted: false } : null
  }
  if (type === 'stock.adjust') {
    const p = payload as AdjustPayload
    return p.variant_id === variantId ? { type, qty: p.counted_qty, counted: true } : null
  }
  if (type === 'invoice.create') {
    const qty = (payload as InvoiceCreatePayload).lines
      .filter((l) => l.variant_id === variantId)
      .reduce((sum, l) => sum + l.qty, 0)
    return qty > 0 ? { type, qty: -qty, counted: false } : null
  }
  if (type === 'invoice.cancel') {
    const qty = (payload as CancelPayload).lines
      .filter((l) => l.variant_id === variantId)
      .reduce((sum, l) => sum + l.qty, 0)
    return qty > 0 ? { type, qty, counted: false } : null
  }
  if (type === 'return.create') {
    // Damaged goods do not go back on the shelf.
    const qty = (payload as ReturnCreatePayload).lines
      .filter((l) => l.variant_id === variantId && l.disposition === 'restock')
      .reduce((sum, l) => sum + l.qty, 0)
    return qty > 0 ? { type, qty, counted: false } : null
  }
  return null
}
