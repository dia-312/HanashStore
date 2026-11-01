const number = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Integer agorot to the display form `₪ 1,250.00` (Latin digits, SPEC section 7). Never floats upstream. */
export function formatMoney(agorot: number): string {
  if (!Number.isInteger(agorot)) throw new Error('Money must be an integer number of agorot')
  const sign = agorot < 0 ? '-' : ''
  const abs = Math.abs(agorot)
  return `${sign}₪ ${number.format(Math.trunc(abs / 100) + (abs % 100) / 100)}`
}

const ARABIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g
/** The Latin digits of what was typed: the iPad's Arabic keyboard types ٠١٢٣, not 0123. */
export const latinDigits = (text: string) =>
  text.replace(ARABIC_DIGITS, (c) => String((c.charCodeAt(0) - 0x0660) % 0x90))

/** A whole number of units typed by the rep ("3", "٣", " 12 "), or null if it isn't one. */
export function parseCount(input: string): number | null {
  const text = latinDigits(input).trim()
  return /^\d{1,9}$/.test(text) ? Number(text) : null
}

export const MAX_AGOROT = 10_000_000 * 100 // SPEC section 13: up to 10,000,000 ILS

/** What the user typed ("12.5", "١٢٫٥٠", "1,250.00") to integer agorot, or null if it isn't a price.
 * Pure string math, no floats (SPEC section 7); at most two decimals. */
export function parseMoney(input: string): number | null {
  let text = latinDigits(input.trim())
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/[\s\u00a0]/g, '')
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '')
  else if (/^\d+,\d{1,2}$/.test(text)) text = text.replace(',', '.')
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) return null
  const agorot = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return agorot <= MAX_AGOROT ? agorot : null
}

/** Agorot to what goes in an input box: 1250 -> "12.5", 1200 -> "12". */
export function agorotToInput(agorot: number): string {
  const whole = Math.trunc(agorot / 100)
  const cents = agorot % 100
  return cents === 0
    ? String(whole)
    : `${whole}.${String(cents).padStart(2, '0').replace(/0$/, '')}`
}
