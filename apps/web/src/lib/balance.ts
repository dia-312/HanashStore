import { ar, fill } from '../i18n/ar'
import { formatMoney } from './money'

/** How a balance reads: owes (positive), in credit (negative), or clear. */
export function balanceView(agorot: number): { kind: 'owes' | 'credit' | 'clear'; text: string } {
  if (agorot > 0)
    return { kind: 'owes', text: fill(ar.customers.owes, { amount: formatMoney(agorot) }) }
  if (agorot < 0)
    return { kind: 'credit', text: fill(ar.customers.credit, { amount: formatMoney(-agorot) }) }
  return { kind: 'clear', text: ar.customers.clear }
}
