// Command types and payloads the device can push (SPEC section 8, apps/api/app/schemas.py).
// Only the stock commands exist so far; the others arrive with their milestones.

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

export type CommandType = 'stock.purchase' | 'stock.damage' | 'stock.adjust'

export interface CommandResult {
  id: string
  status: 'applied' | 'rejected'
  data?: { applied: number; variants: { id: string; stock_qty: number; change_seq: number }[] }
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
    default:
      return []
  }
}

/** What a waiting command does to one variant, for the movement history: a signed quantity for a
 * stock-in or write-off, or the counted quantity for a count. */
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
  return null
}
