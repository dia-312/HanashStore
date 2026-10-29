const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Integer agorot -> "₪ 1,250.00" (Latin digits, comma thousands; SPEC section 7). */
export const fmtMoney = (agorot: number) => `₪ ${money.format(agorot / 100)}`
