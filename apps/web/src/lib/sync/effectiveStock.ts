import type { OutboxRow } from '../../db'
import type { AdjustPayload, DamagePayload, PurchasePayload } from './commands'

type PendingCommand = Pick<OutboxRow, 'type' | 'payload' | 'status'>

/**
 * The stock the rep should see: what the server last said, plus the commands still waiting, applied
 * in the order they were made. Mirrors the server's rules (a write-off can't take stock below zero,
 * a count sets the quantity), so a command the server would refuse changes nothing here either.
 * Rejected commands are skipped, which is all it takes to undo their effect on screen.
 *
 * Returns only the variants a pending command touches.
 */
export function pendingStock(
  base: ReadonlyMap<string, number>,
  commands: readonly PendingCommand[],
): Map<string, number> {
  const current = new Map<string, number>()
  const get = (id: string) => current.get(id) ?? base.get(id)
  for (const command of commands) {
    if (command.status !== 'pending') continue
    if (command.type === 'stock.purchase') {
      for (const item of (command.payload as PurchasePayload).items) {
        const qty = get(item.variant_id)
        if (qty !== undefined) current.set(item.variant_id, qty + item.qty)
      }
    } else if (command.type === 'stock.damage') {
      const { variant_id, qty: out } = command.payload as DamagePayload
      const qty = get(variant_id)
      if (qty !== undefined && out <= qty) current.set(variant_id, qty - out)
    } else if (command.type === 'stock.adjust') {
      const { variant_id, counted_qty } = command.payload as AdjustPayload
      if (get(variant_id) !== undefined) current.set(variant_id, counted_qty)
    }
  }
  return current
}

/** Stock of one variant with the waiting commands counted. */
export function effectiveStock(
  variantId: string,
  serverQty: number,
  commands: readonly PendingCommand[],
): number {
  return pendingStock(new Map([[variantId, serverQty]]), commands).get(variantId) ?? serverQty
}
