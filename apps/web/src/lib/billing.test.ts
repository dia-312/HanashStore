import { describe, expect, it } from 'vitest'
import cases from '../../../../shared/billing_cases.json'
import {
  allocateDiscount,
  customerBalance,
  invoiceTotals,
  lineTotal,
  remainingOnInvoice,
  returnLineAmount,
} from './billing'

describe('billing rules match the shared fixtures (same file the server is tested with)', () => {
  it.each(cases.discount)('discount $discount over $line_totals', (c) => {
    expect(allocateDiscount(c.line_totals, c.discount)).toEqual(c.shares)
  })

  it.each(cases.totals)('totals of $line_totals with discount $discount', (c) => {
    expect(invoiceTotals(c.line_totals, c.discount)).toEqual({
      subtotal: c.subtotal,
      total: c.total,
    })
  })

  it.each(cases.remaining)('remaining on $total after paying $paid', (c) => {
    expect(remainingOnInvoice(c.total, c.paid)).toBe(c.remaining)
  })

  it.each(cases.returns)('return amounts of $picks on a $sold unit line', (c) => {
    let qty = 0
    let amount = 0
    const got = c.picks.map((pick) => {
      const a = returnLineAmount(c.line_total, c.discount_share, c.sold, qty, amount, pick)
      qty += pick
      amount += a
      return a
    })
    expect(got).toEqual(c.amounts)
  })

  it.each(cases.balance)('balance with opening $opening', (c) => {
    expect(customerBalance(c.opening, c.invoices, c.returns, c.payments)).toBe(c.balance)
  })
})

describe('billing rules', () => {
  it('a line is quantity times price', () => {
    expect(lineTotal(3, 4500)).toBe(13500)
  })

  it('the shares always add up to the discount and stay inside each line', () => {
    let seed = 12345
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % (max + 1)
    }
    for (let n = 0; n < 500; n++) {
      const totals = Array.from({ length: 1 + next(7) }, () => next(50_000))
      const subtotal = totals.reduce((a, b) => a + b, 0)
      const discount = next(subtotal)
      const shares = allocateDiscount(totals, discount)
      expect(shares.reduce((a, b) => a + b, 0)).toBe(discount)
      shares.forEach((share, i) => {
        expect(share).toBeGreaterThanOrEqual(0)
        expect(share).toBeLessThanOrEqual(totals[i]!)
      })
    }
  })

  it('stays exact for very large invoices', () => {
    const totals = [9_999_999_99, 9_999_999_99, 9_999_999_98]
    const shares = allocateDiscount(totals, 1_234_567_890)
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_234_567_890)
  })

  it('refuses a discount larger than the invoice or below zero', () => {
    expect(() => allocateDiscount([100, 200], 301)).toThrow(RangeError)
    expect(() => invoiceTotals([100], -1)).toThrow(RangeError)
  })

  it('an overpayment leaves nothing remaining on the invoice', () => {
    expect(remainingOnInvoice(10000, 15000)).toBe(0)
  })
})
