import { db, type DbCart } from '../db'

// A cart is a draft sale kept only on this device (SPEC F7): one open cart per customer, plus one
// for a sale with no customer yet. Stock is never reserved by a cart; the stepper and the confirm
// button check what is on the shelf at that moment.

export const NO_CUSTOMER = 'none'
export const cartIdOf = (customerId: string | null) => customerId ?? NO_CUSTOMER

export const getCart = (customerId: string | null) => db.carts.get(cartIdOf(customerId))

const save = async (cart: DbCart) => {
  if (cart.lines.length === 0) await db.carts.delete(cart.id)
  else await db.carts.put(cart)
}

const emptyCart = (customerId: string | null): DbCart => ({
  id: cartIdOf(customerId),
  customer_id: customerId,
  lines: [],
  updated_at: new Date().toISOString(),
})

/** Sets how many of a variant are in the cart; zero (or less) takes the line out. */
export async function setLineQty(
  customerId: string | null,
  variantId: string,
  qty: number,
): Promise<void> {
  await db.transaction('rw', db.carts, async () => {
    const cart = (await getCart(customerId)) ?? emptyCart(customerId)
    const lines = cart.lines.filter((l) => l.variant_id !== variantId)
    if (qty > 0) {
      const index = cart.lines.findIndex((l) => l.variant_id === variantId)
      // A changed quantity keeps its place in the cart.
      if (index >= 0) lines.splice(index, 0, { variant_id: variantId, qty })
      else lines.push({ variant_id: variantId, qty })
    }
    await save({ ...cart, lines, updated_at: new Date().toISOString() })
  })
}

export async function clearCart(customerId: string | null): Promise<void> {
  await db.carts.delete(cartIdOf(customerId))
}

/** The sale began with no customer and one was picked at checkout: the lines move to his cart,
 * joining whatever he already had waiting. */
export async function moveCartToCustomer(customerId: string): Promise<void> {
  await db.transaction('rw', db.carts, async () => {
    const from = await getCart(null)
    if (!from) return
    const to = (await getCart(customerId)) ?? emptyCart(customerId)
    const lines = [...to.lines]
    for (const line of from.lines) {
      const existing = lines.find((l) => l.variant_id === line.variant_id)
      if (existing) existing.qty += line.qty
      else lines.push({ ...line })
    }
    await save({ ...to, lines, updated_at: new Date().toISOString() })
    await db.carts.delete(cartIdOf(null))
  })
}

/** What the stepper allows: never more than is on the shelf, never below zero. */
export const clampQty = (qty: number, available: number) =>
  Math.max(0, Math.min(Math.trunc(qty), Math.max(available, 0)))
