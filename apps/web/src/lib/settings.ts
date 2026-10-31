import { db } from '../db'
import { api } from './api'
import { useLive } from './useLive'
import { syncNow } from './sync/engine'

// Business details shown on invoices and statements, and one presentation switch. They come from
// the server with every pull and live in Dexie, so the offline image has them too. The defaults
// are placeholders until the client gives his name, phone and logo (SPEC section 16); they match
// apps/api/app/services/settings.py.

export interface Business {
  business_name: string
  phone: string
  invoice_footer: string
  logo_url: string | null
  hide_out_of_stock_in_presentation: boolean
}

export const DEFAULT_SETTINGS: Business = {
  business_name: 'اسم المنشأة',
  phone: '',
  invoice_footer: '',
  logo_url: null,
  hide_out_of_stock_in_presentation: true,
}

export async function loadSettings(): Promise<Business> {
  const values: Record<string, unknown> = {}
  for (const row of await db.settings.toArray()) values[row.key] = row.value
  return { ...DEFAULT_SETTINGS, ...values } as Business
}

/** The settings, live. `undefined` for the first moment while the device is read. */
export const useSettings = () => useLive(loadSettings, [])

type Patch = Partial<
  Pick<Business, 'business_name' | 'phone' | 'invoice_footer' | 'hide_out_of_stock_in_presentation'>
> & {
  logo_url?: null
}

/** Online only, like the rest of editing: the server keeps the truth, the device follows. */
export async function saveSettings(patch: Patch): Promise<void> {
  await api('/settings', { method: 'PATCH', body: patch })
  await syncNow()
}

export async function uploadLogo(file: File): Promise<void> {
  const body = new FormData()
  body.append('file', file)
  await api('/settings/logo', { method: 'POST', body })
  await syncNow()
}
