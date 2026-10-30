import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_LIMIT_MS,
  IDLE_LIMIT_MS,
  MAX_WRONG_PINS,
  OFFLINE_DELAYS_MS,
  backgroundExpired,
  freshAttempts,
  idleExpired,
  recordWrongPin,
  remainingLockMs,
} from './lock'
import { formatMoney } from './money'
import { createPinRecord, isValidPin, verifyPin } from './pin'
import { uuid7 } from './uuid7'

describe('uuid7', () => {
  it('has version 7, the RFC variant and the timestamp in the top 48 bits', () => {
    const id = uuid7(1_700_000_000_000)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(BigInt('0x' + id.replaceAll('-', '').slice(0, 12))).toBe(1_700_000_000_000n)
  })

  it('sorts by creation time and does not repeat', () => {
    expect(uuid7(1000) < uuid7(1001)).toBe(true)
    expect(new Set(Array.from({ length: 1000 }, () => uuid7())).size).toBe(1000)
  })
})

describe('formatMoney', () => {
  it.each([
    [0, '₪ 0.00'],
    [5, '₪ 0.05'],
    [125000, '₪ 1,250.00'],
    [123456789, '₪ 1,234,567.89'],
    [-4550, '-₪ 45.50'],
  ])('%i agorot is %s', (agorot, text) => {
    expect(formatMoney(agorot)).toBe(text)
  })

  it('rejects fractions of an agora', () => {
    expect(() => formatMoney(10.5)).toThrow()
  })
})

describe('PIN hash', () => {
  it('verifies the right PIN only, with a random salt each time', async () => {
    const a = await createPinRecord('4821', 1000)
    const b = await createPinRecord('4821', 1000)
    expect(a.salt).not.toBe(b.salt)
    expect(a.length).toBe(4)
    expect(JSON.stringify(a)).not.toContain('4821')
    expect(await verifyPin(a, '4821')).toBe(true)
    expect(await verifyPin(a, '4822')).toBe(false)
  })

  it('accepts only 4 to 6 Latin digits', () => {
    for (const ok of ['1234', '12345', '123456']) expect(isValidPin(ok)).toBe(true)
    for (const bad of ['123', '1234567', '12a4', '', '١٢٣٤']) expect(isValidPin(bad)).toBe(false)
  })
})

describe('lock rules', () => {
  it('locks after 5 minutes idle or in the background, not before', () => {
    expect(idleExpired(0, IDLE_LIMIT_MS - 1)).toBe(false)
    expect(idleExpired(0, IDLE_LIMIT_MS)).toBe(true)
    expect(backgroundExpired(0, BACKGROUND_LIMIT_MS - 1)).toBe(false)
    expect(backgroundExpired(0, BACKGROUND_LIMIT_MS)).toBe(true)
  })

  it('offline: every 5 wrong PINs lock for 1, then 5, then 15 minutes', () => {
    let a = freshAttempts()
    let now = 1_000_000
    const expected = [...OFFLINE_DELAYS_MS, OFFLINE_DELAYS_MS.at(-1)!]
    for (const delay of expected) {
      for (let i = 0; i < MAX_WRONG_PINS - 1; i++) {
        a = recordWrongPin(a, now, false)
        expect(remainingLockMs(a, now)).toBe(0)
      }
      a = recordWrongPin(a, now, false)
      expect(remainingLockMs(a, now)).toBe(delay)
      now += delay // waited it out
      expect(remainingLockMs(a, now)).toBe(0)
    }
  })

  it('online: 5 wrong PINs demand the full password instead of a delay', () => {
    let a = freshAttempts()
    for (let i = 0; i < MAX_WRONG_PINS; i++) a = recordWrongPin(a, 0, true)
    expect(a.requirePassword).toBe(true)
    expect(remainingLockMs(a, 0)).toBe(0)
  })
})
