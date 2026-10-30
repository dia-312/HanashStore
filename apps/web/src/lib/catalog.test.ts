import { describe, expect, it } from 'vitest'
import cases from '../../../../shared/normalize_cases.json'
import { ApiError } from './api'
import { formatDateTime } from './date'
import { describeError } from './errors'
import { agorotToInput, parseMoney } from './money'
import { normalizeArabic } from './normalize'
import { countDifference } from '../screens/stock/StockSingle'
import { issueText } from '../screens/settings/ImportProducts'

describe('normalizeArabic', () => {
  it.each(cases)('matches the shared fixture: $input', ({ input, expected }) => {
    expect(normalizeArabic(input)).toBe(expected)
  })

  it('treats the SPEC search spellings as one word', () => {
    expect(normalizeArabic('ارجيله')).toBe(normalizeArabic('أرجيلة'))
  })
})

describe('parseMoney', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['12.50', 1250],
    ['0', 0],
    ['1,250.00', 125000],
    ['12,5', 1250],
    ['١٢٫٥٠', 1250],
    ['٢٥', 2500],
    ['۱۲.۵', 1250],
    [' 7 ', 700],
    ['0.05', 5],
  ])('%s -> %i agorot', (text, agorot) => {
    expect(parseMoney(text)).toBe(agorot)
  })

  it.each(['', 'abc', '-5', '1.234', '1e3', '12 ₪', '10000001', '.5', '1.'])(
    'rejects %j',
    (text) => {
      expect(parseMoney(text)).toBeNull()
    },
  )

  it('never goes through floats', () => {
    // 0.1 + 0.2 style traps: every value stays an exact integer of agorot.
    for (const text of ['0.07', '1.15', '4.35', '19.99', '1000000.01']) {
      const agorot = parseMoney(text)
      expect(Number.isInteger(agorot)).toBe(true)
      expect(agorotToInput(agorot ?? 0)).toBe(text.replace(/0$/, ''))
    }
  })
})

describe('agorotToInput', () => {
  it('round-trips with parseMoney', () => {
    for (const agorot of [0, 5, 100, 1250, 1205, 99999, 125000]) {
      expect(parseMoney(agorotToInput(agorot))).toBe(agorot)
    }
    expect(agorotToInput(1250)).toBe('12.5')
    expect(agorotToInput(1200)).toBe('12')
  })
})

describe('formatDateTime', () => {
  it('shows dd/MM/yyyy HH:mm in Asia/Hebron with Latin digits', () => {
    // 2026-10-30 is after the October DST change in Palestine: UTC+2.
    expect(formatDateTime('2026-10-30T12:05:00Z')).toBe('30/10/2026 14:05')
    expect(formatDateTime('2026-07-01T00:30:00Z')).toBe('01/07/2026 03:30') // summer: UTC+3
  })
})

describe('describeError', () => {
  it('maps server codes to Arabic messages', () => {
    expect(describeError(new ApiError(0, 'NETWORK', ''))).toContain('الإنترنت')
    expect(describeError(new ApiError(409, 'INSUFFICIENT_STOCK', '', { available: 3 }))).toContain(
      '3',
    )
    expect(describeError(new ApiError(409, 'DUPLICATE_VARIANT', ''))).toContain('اللون')
    expect(describeError(new Error('boom'))).toBeTruthy()
    expect(describeError(new ApiError(500, 'SOMETHING_NEW', ''))).toBeTruthy()
  })
})

describe('stock count difference', () => {
  it('is counted minus system', () => {
    expect(countDifference(10, 7)).toBe(-3)
    expect(countDifference(10, 12)).toBe(2)
    expect(countDifference(4, 4)).toBe(0)
  })
})

describe('import issue text', () => {
  it('turns a server issue into a sentence', () => {
    expect(issueText({ row: 4, field: 'price', code: 'BAD_PRICE', detail: 'abc' })).toContain('abc')
    expect(
      issueText({ row: 11, field: 'color', code: 'DUPLICATE_IN_FILE', detail: '10' }),
    ).toContain('10')
    expect(issueText({ row: 1, field: 'price', code: 'MISSING_COLUMN', detail: null })).toContain(
      'السعر',
    )
    expect(issueText({ row: 2, field: 'x', code: 'UNKNOWN_CODE', detail: null })).toBe(
      'UNKNOWN_CODE',
    )
  })
})
