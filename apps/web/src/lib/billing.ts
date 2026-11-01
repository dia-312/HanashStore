// Money rules for invoices and balances (SPEC section 7). Integer agorot everywhere, never floats.
// The same rules live in apps/api/app/services/billing.py; both are tested against
// shared/billing_cases.json. This copy exists so previews offline match: the server recalculates
// and its answer wins.

export const lineTotal = (qty: number, unitPrice: number) => qty * unitPrice

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0)

/** Subtotal and total of an invoice with a fixed discount (0 <= discount <= subtotal). */
export function invoiceTotals(
  lineTotals: readonly number[],
  discount: number,
): { subtotal: number; total: number } {
  const subtotal = sum(lineTotals)
  if (discount < 0 || discount > subtotal) throw new RangeError('discount out of range')
  return { subtotal, total: subtotal - discount }
}

/**
 * Splits a discount over the lines in proportion to their totals: each share rounded down to the
 * agora, the agorot left over given one by one to the lines with the largest remainders (ties: the
 * earlier line). The shares always add up to the discount.
 */
export function allocateDiscount(lineTotals: readonly number[], discount: number): number[] {
  const subtotal = sum(lineTotals)
  if (discount < 0 || discount > subtotal) throw new RangeError('discount out of range')
  if (discount === 0 || subtotal === 0) return lineTotals.map(() => 0)
  // BigInt keeps the products exact however large the invoice is.
  const d = BigInt(discount)
  const s = BigInt(subtotal)
  const shares = lineTotals.map((t) => Number((d * BigInt(t)) / s))
  const remainders = lineTotals.map((t) => Number((d * BigInt(t)) % s))
  let leftover = discount - sum(shares)
  const order = lineTotals.map((_, i) => i).sort((a, b) => remainders[b]! - remainders[a]! || a - b)
  for (const i of order) {
    if (leftover === 0) break
    shares[i]! += 1
    leftover -= 1
  }
  return shares
}

/** What is still owed on one invoice: never negative (an overpayment is credit elsewhere). */
export const remainingOnInvoice = (total: number, paid: number) => Math.max(total - paid, 0)

/**
 * What a customer is credited for taking `qty` units of an invoice line back. The line is worth
 * `lineTotal - discountShare`; a part is worth that times `qty / soldQty`, rounded down, and the
 * return that takes the last unit gets what is left, so a line's returns add up to exactly its
 * value. Same rule as apps/api/app/services/billing.py (shared/billing_cases.json).
 */
export function returnLineAmount(
  lineTotal: number,
  discountShare: number,
  soldQty: number,
  alreadyQty: number,
  alreadyAmount: number,
  qty: number,
): number {
  if (soldQty <= 0 || qty <= 0 || alreadyQty < 0 || alreadyQty + qty > soldQty) {
    throw new RangeError('quantity out of range')
  }
  const net = lineTotal - discountShare
  if (alreadyQty + qty === soldQty) return net - alreadyAmount
  return Number((BigInt(net) * BigInt(qty)) / BigInt(soldQty))
}

/** Positive = the customer owes. */
export const customerBalance = (
  opening: number,
  invoicesTotal: number,
  returnsTotal: number,
  paymentsTotal: number,
) => opening + invoicesTotal - returnsTotal - paymentsTotal
