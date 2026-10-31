const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Hebron',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const dayFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Hebron',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

/** ISO timestamp to `dd/MM/yyyy` in Asia/Hebron. */
export const formatDate = (iso: string): string => dayFormatter.format(new Date(iso))

const isoDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Hebron',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** ISO timestamp to the Hebron calendar day as `yyyy-MM-dd`: comparable as text. */
export const hebronDay = (iso: string): string => isoDayFormatter.format(new Date(iso))

/** `yyyy-MM-dd` to `dd/MM/yyyy`. */
export const dayToDisplay = (day: string): string => day.split('-').reverse().join('/')

/** ISO timestamp to `dd/MM/yyyy HH:mm` in Asia/Hebron with Latin digits (SPEC section 7). */
export function formatDateTime(iso: string): string {
  return formatter.format(new Date(iso)).replace(',', '')
}
