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
