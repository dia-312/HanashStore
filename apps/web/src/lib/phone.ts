// Calls and WhatsApp go through the phone number as the rep typed it. WhatsApp needs the country
// code: a number that starts with 0 is taken as a local one and gets this prefix (an assumption
// until the client says which numbers he uses, SPEC section 16).
export const DEFAULT_COUNTRY_CODE = '970'

const digits = (phone: string) => phone.replace(/[^\d+]/g, '')

export const telUrl = (phone: string) => `tel:${digits(phone)}`

export function whatsappUrl(phone: string): string {
  let number = digits(phone)
  if (number.startsWith('+')) number = number.slice(1)
  else if (number.startsWith('00')) number = number.slice(2)
  else if (number.startsWith('0')) number = DEFAULT_COUNTRY_CODE + number.slice(1)
  return `https://wa.me/${number}`
}
