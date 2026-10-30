import { db } from '../../db'
import type { AdjustPayload, DamagePayload, PurchasePayload } from './commands'
import { syncNow } from './engine'
import { pendingStock } from './effectiveStock'
import { enqueue, pendingCommands } from './outbox'

/** What the rep sees right after confirming: the new quantity of each variant touched. */
export interface LocalStockResult {
  variants: { id: string; sku: string; stock_qty: number }[]
}

async function result(variantIds: string[]): Promise<LocalStockResult> {
  const ids = [...new Set(variantIds)]
  const rows = (await db.variants.bulkGet(ids)).filter((v) => v !== undefined)
  const effective = pendingStock(
    new Map(rows.map((v) => [v.id, v.stock_qty])),
    await pendingCommands(),
  )
  return {
    variants: rows.map((v) => ({
      id: v.id,
      sku: v.sku,
      stock_qty: effective.get(v.id) ?? v.stock_qty,
    })),
  }
}

/** The command is saved on the device first, so this works without a network; sending starts
 * right away when there is one but is never waited for. */
async function queue(
  type: 'stock.purchase' | 'stock.damage' | 'stock.adjust',
  payload: PurchasePayload | DamagePayload | AdjustPayload,
  variantIds: string[],
): Promise<LocalStockResult> {
  await enqueue(type, payload)
  void syncNow()
  return result(variantIds)
}

export function queuePurchase(
  note: string | null,
  items: { movementId: string; variantId: string; qty: number }[],
): Promise<LocalStockResult> {
  return queue(
    'stock.purchase',
    {
      note,
      items: items.map((i) => ({ movement_id: i.movementId, variant_id: i.variantId, qty: i.qty })),
    },
    items.map((i) => i.variantId),
  )
}

export function queueDamage(input: {
  movementId: string
  variantId: string
  qty: number
  note: string
}): Promise<LocalStockResult> {
  return queue(
    'stock.damage',
    {
      movement_id: input.movementId,
      variant_id: input.variantId,
      qty: input.qty,
      note: input.note,
    },
    [input.variantId],
  )
}

export function queueCount(input: {
  movementId: string
  variantId: string
  counted: number
  expected: number
  note: string
}): Promise<LocalStockResult> {
  return queue(
    'stock.adjust',
    {
      movement_id: input.movementId,
      variant_id: input.variantId,
      counted_qty: input.counted,
      expected_qty: input.expected,
      note: input.note,
    },
    [input.variantId],
  )
}
