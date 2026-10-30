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
