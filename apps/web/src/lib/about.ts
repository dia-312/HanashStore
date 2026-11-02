// Who made the app (shown in Settings → About, and on the sign-in page).
export const DEVELOPER = { ar: 'ضياء عرار', en: 'Diaa Arar' } as const

/** The year the app was first made; a copyright year is not "this year". */
export const COPYRIGHT_YEAR = 2026

/** From package.json at build time (see vite.config.ts). */
export const APP_VERSION: string = __APP_VERSION__
