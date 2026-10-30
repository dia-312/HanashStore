const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Hebron',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** ISO timestamp to `dd/MM/yyyy HH:mm` in Asia/Hebron with Latin digits (SPEC section 7). */
export function formatDateTime(iso: string): string {
  return formatter.format(new Date(iso)).replace(',', '')
}
