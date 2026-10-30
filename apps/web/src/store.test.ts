import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, getMeta } from './db'
import { resetAuthStore, useAuth } from './store'

const me = {
  user: { id: 'u1', name: 'Rep' },
  device: { id: 'd1', name: 'iPad' },
  has_pin: false,
}

interface Call {
  path: string
  method: string
  body: unknown
  headers: Record<string, string>
}

let calls: Call[]
let respond: (call: Call) => Response

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(async () => {
  await db.meta.clear()
  resetAuthStore()
  calls = []
  respond = (c) => (c.path.endsWith('/pin') ? new Response(null, { status: 204 }) : json(200, me))
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call: Call = {
      path: url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
      headers: init.headers as Record<string, string>,
    }
    calls.push(call)
    return respond(call)
  })
  vi.stubGlobal('navigator', { ...navigator, onLine: true, userAgent: 'iPad' })
})

afterEach(() => vi.unstubAllGlobals())

describe('auth store', () => {
  it('starts logged out on a fresh device', async () => {
    await useAuth.getState().boot()
    expect(useAuth.getState().status).toBe('loggedOut')
  })

  it('login then PIN setup unlocks, and writes send the CSRF header', async () => {
    await useAuth.getState().boot()
    await useAuth.getState().login('secret-password')
    expect(useAuth.getState().status).toBe('needsPin')
    expect(calls[0]).toMatchObject({
      path: '/api/v1/auth/login',
      method: 'POST',
      body: { password: 'secret-password', device_name: 'iPad', confirm_replace: false },
    })
    expect(calls[0]!.headers['X-Requested-With']).toBe('app')

    await useAuth.getState().savePin('4821')
    expect(useAuth.getState().status).toBe('unlocked')
    expect(calls[1]).toMatchObject({
      path: '/api/v1/auth/pin',
      method: 'PUT',
      body: { pin: '4821' },
    })
    const stored = JSON.stringify(await getMeta('pin'))
    expect(stored).not.toContain('4821')
  })

  it('after a restart the app opens locked and unlocks with the right PIN offline', async () => {
    await useAuth.getState().login('pw')
    await useAuth.getState().savePin('4821')
    resetAuthStore()
    vi.stubGlobal('navigator', { ...navigator, onLine: false, userAgent: 'iPad' })
    calls.length = 0

    await useAuth.getState().boot()
    expect(useAuth.getState().status).toBe('locked')
    expect(useAuth.getState().pinLength).toBe(4)
    expect(calls).toHaveLength(0) // no network needed to reach the lock screen
    expect(await useAuth.getState().unlock('0000')).toBe('wrong')
    expect(await useAuth.getState().unlock('4821')).toBe('ok')
    expect(useAuth.getState().status).toBe('unlocked')
  })

  it('offline, five wrong PINs lock the pad even for the right PIN', async () => {
    await useAuth.getState().login('pw')
    await useAuth.getState().savePin('4821')
    useAuth.getState().lock()
    vi.stubGlobal('navigator', { ...navigator, onLine: false, userAgent: 'iPad' })

    const results = []
    for (let i = 0; i < 5; i++) results.push(await useAuth.getState().unlock('1111'))
    expect(results).toEqual(['wrong', 'wrong', 'wrong', 'wrong', 'locked'])
    expect(await useAuth.getState().unlock('4821')).toBe('locked')
    expect(useAuth.getState().status).toBe('locked')
  })

  it('online, five wrong PINs require the password, which then unlocks', async () => {
    await useAuth.getState().login('pw')
    await useAuth.getState().savePin('4821')
    useAuth.getState().lock()
    for (let i = 0; i < 4; i++) await useAuth.getState().unlock('1111')
    expect(await useAuth.getState().unlock('1111')).toBe('password')
    expect(await useAuth.getState().unlock('4821')).toBe('password')

    await useAuth.getState().unlockWithPassword('pw')
    expect(useAuth.getState().status).toBe('unlocked')
    expect(useAuth.getState().attempts.requirePassword).toBe(false)
  })

  it('a revoked device wipes its local data', async () => {
    await useAuth.getState().login('pw')
    await useAuth.getState().savePin('4821')
    resetAuthStore()
    respond = () => json(401, { code: 'DEVICE_REVOKED', message: 'revoked', details: {} })

    await useAuth.getState().boot()
    await vi.waitFor(() => expect(useAuth.getState().status).toBe('loggedOut'))
    expect(await db.meta.count()).toBe(0)
  })

  it('an expired session keeps the data and only raises a flag', async () => {
    await useAuth.getState().login('pw')
    await useAuth.getState().savePin('4821')
    resetAuthStore()
    respond = () => json(401, { code: 'UNAUTHENTICATED', message: 'expired', details: {} })

    await useAuth.getState().boot()
    await vi.waitFor(() => expect(useAuth.getState().sessionExpired).toBe(true))
    expect(useAuth.getState().status).toBe('locked')
    expect(await getMeta('pin')).toBeDefined()
  })

  it('logout wipes local data and ends the session on the server', async () => {
    await useAuth.getState().login('pw')
    await useAuth.getState().savePin('4821')
    await useAuth.getState().logout()
    expect(calls.at(-1)).toMatchObject({ path: '/api/v1/auth/logout', method: 'POST' })
    expect(useAuth.getState().status).toBe('loggedOut')
    expect(await db.meta.count()).toBe(0)
  })

  it('logging in again after an expired session keeps the existing PIN', async () => {
    await useAuth.getState().login('pw')
    await useAuth.getState().savePin('4821')
    useAuth.getState().lock()
    await useAuth.getState().login('pw')
    expect(useAuth.getState().status).toBe('unlocked')
    expect(calls.at(-1)!.body).toMatchObject({ device_id: 'd1' }) // same device, no replace prompt
  })
})
