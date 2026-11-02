import { describe, expect, it } from 'vitest'
import { presetRange, rangeOk } from './reportsApi'

describe('the periods the reports screen offers', () => {
  const today = '2026-11-03'
  it.each([
    ['today', '2026-11-03', '2026-11-03'],
    ['week', '2026-10-28', '2026-11-03'], // 7 days including today
    ['month', '2026-11-01', '2026-11-03'],
    ['lastMonth', '2026-10-01', '2026-10-31'],
    ['quarter', '2026-08-06', '2026-11-03'], // 90 days
    ['year', '2025-11-04', '2026-11-03'], // 365 days
  ] as const)('%s', (preset, from, to) => {
    expect(presetRange(preset, today)).toEqual({ from, to })
  })

  it('in January, last month is December of the year before', () => {
    expect(presetRange('lastMonth', '2027-01-05')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  })

  it('last month ends on its real last day, also in a leap year', () => {
    expect(presetRange('lastMonth', '2024-03-10')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(presetRange('lastMonth', '2026-05-31')).toEqual({ from: '2026-04-01', to: '2026-04-30' })
  })

  it('every preset is a range the server accepts', () => {
    for (const p of ['today', 'week', 'month', 'lastMonth', 'quarter', 'year'] as const) {
      expect(rangeOk(presetRange(p, today)), p).toBe(true)
    }
  })
})

describe('a range the server will accept', () => {
  it('needs real dates in order', () => {
    expect(rangeOk({ from: '2026-11-01', to: '2026-11-03' })).toBe(true)
    expect(rangeOk({ from: '2026-11-03', to: '2026-11-03' })).toBe(true)
    expect(rangeOk({ from: '2026-11-04', to: '2026-11-03' })).toBe(false)
    expect(rangeOk({ from: '', to: '2026-11-03' })).toBe(false)
    expect(rangeOk({ from: '03/11/2026', to: '2026-11-03' })).toBe(false)
  })

  it('is at most two years of days, and between 2000 and 2100', () => {
    expect(rangeOk({ from: '2024-11-04', to: '2026-11-03' })).toBe(true) // 730 days
    expect(rangeOk({ from: '2024-11-03', to: '2026-11-03' })).toBe(true) // 731: the limit
    expect(rangeOk({ from: '2024-11-02', to: '2026-11-03' })).toBe(false)
    expect(rangeOk({ from: '1999-12-31', to: '2000-01-02' })).toBe(false)
    expect(rangeOk({ from: '2100-12-30', to: '2101-01-01' })).toBe(false)
  })
})
