import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, setMeta, wipeLocalData } from '../db'
import { api } from './api'
import { CLOCK_LIMIT_MS, clockAware, clockLooksWrong, skewTooBig } from './clockGuard'
import { SaleError, confirmSale, recordPayment, recordRefund, saveCustomer } from './sales'

// QA decision: a document is dated by the iPad's clock, so while that clock is plainly wrong no
// document is made. Evidence: the server's time (read on every answer) or the device being earlier
// than its own last sync.

/** One server answer whose clock is `offsetMs` ahead of this device's. */
const serverSays = async (offsetMs: number) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'X-Server-Time': new Date(Date.now() + offsetMs).toISOString(),
          },
        }),
    ),
  )
  await api('/auth/me')
  vi.unstubAllGlobals()
}

beforeEach(async () => {
  await wipeLocalData()
  await serverSays(0)
})

afterEach(async () => {
  await serverSays(0) // the reading is kept between tests in this file
})

describe('the evidence', () => {
  it('a clock within five minutes of the server is fine, beyond that it is not', async () => {
    expect(skewTooBig(null)).toBe(false)
    await serverSays(CLOCK_LIMIT_MS - 10_000)
    expect(await clockLooksWrong()).toBe(false)
    await serverSays(CLOCK_LIMIT_MS + 60_000)
    expect(await clockLooksWrong()).toBe(true)
    await serverSays(-(CLOCK_LIMIT_MS + 60_000))
    expect(await clockLooksWrong()).toBe(true)
  })

  it('a device that is earlier than its own last sync has had its clock moved back', async () => {
    await setMeta('lastSyncAt', Date.now() + 3 * 3_600_000)
    expect(await clockLooksWrong()).toBe(true)
    await setMeta('lastSyncAt', Date.now() - 3 * 3_600_000)
    expect(await clockLooksWrong()).toBe(false)
  })

  it('with no evidence at all (never synced, never answered) nothing is blocked', async () => {
    expect(await clockLooksWrong()).toBe(false)
  })
})

describe('what is refused', () => {
  it('no sale, payment or refund while the clock is wrong, and nothing is saved', async () => {
    const customerId = await saveCustomer({ name: 'محل' })
    await serverSays(2 * 3_600_000)
    const refused = async (job: Promise<unknown>) => {
      await expect(job).rejects.toMatchObject({ code: 'CLOCK_OFF' })
    }
    await refused(recordPayment({ customerId, amount: 100, method: 'cash' }))
    await refused(recordRefund({ customerId, amount: 100, method: 'cash' }))
    await refused(
      confirmSale({
        customerId,
        lines: [{ variantId: 'v', qty: 1 }],
        discount: 0,
        paid: 0,
        method: 'cash',
        payNote: '',
        note: '',
      }),
    )
    expect(await db.payments.count()).toBe(0)
    expect(await db.invoices.count()).toBe(0)
    // the customer written before the clock went wrong is there, and its command is waiting
    expect(await db.outbox.count()).toBe(1)
  })

  it('once the server and the device agree again, the same action works', async () => {
    const customerId = await saveCustomer({ name: 'محل' })
    await serverSays(2 * 3_600_000)
    await expect(recordPayment({ customerId, amount: 100, method: 'cash' })).rejects.toBeInstanceOf(
      SaleError,
    )
    await serverSays(0)
    const { number } = await recordPayment({ customerId, amount: 100, method: 'cash' })
    expect(number).toBe('REC-000001')
  })

  it('says it in words a person can act on', () => {
    expect(clockAware(new SaleError('CLOCK_OFF'), 'x')).toContain('ساعة الجهاز')
    expect(clockAware(new SaleError('NO_REASON'), 'عام')).toBe('عام')
    expect(clockAware('nothing', 'عام')).toBe('عام')
  })
})
