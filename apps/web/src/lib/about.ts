// Who made the app (shown in Settings → About, and on the sign-in page).
export const DEVELOPER = { ar: 'ضياء عرار', en: 'Diaa Arar' } as const

/** The year the app was first made; a copyright year is not "this year". */
export const COPYRIGHT_YEAR = 2026

/**
 * How to reach the developer (shown on the About page). An empty value is not shown: the number is
 * filled in here once the owner gives it, never guessed.
 */
export const CONTACT = {
  email: 'diaaararx@gmail.com',
  /** International format, digits only, no + or spaces (for wa.me), e.g. '9725XXXXXXXX'. */
  whatsapp: '',
} as const

/** From package.json at build time (see vite.config.ts). */
export const APP_VERSION: string = __APP_VERSION__
