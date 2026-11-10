import { describe, expect, it } from 'vitest'
import {
  DOUBLE_TAP_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  clampPan,
  clampScale,
  distance,
  isDoubleTap,
  maxPan,
  pinchScale,
} from './zoom'

describe('picture zoom arithmetic', () => {
  it('keeps the zoom between normal size and the most', () => {
    expect(clampScale(0.3)).toBe(MIN_SCALE)
    expect(clampScale(2)).toBe(2)
    expect(clampScale(99)).toBe(MAX_SCALE)
    expect(clampScale(Number.NaN)).toBe(MIN_SCALE)
    expect(DOUBLE_TAP_SCALE).toBeGreaterThan(MIN_SCALE)
    expect(DOUBLE_TAP_SCALE).toBeLessThan(MAX_SCALE)
  })

  it('measures the distance between two fingers', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })

  it('zooms by how much the fingers spread, from where the zoom started', () => {
    expect(pinchScale(1, 100, 200)).toBe(2)
    expect(pinchScale(2, 100, 150)).toBe(3)
    expect(pinchScale(2, 100, 50)).toBe(1)
    expect(pinchScale(1, 100, 10000)).toBe(MAX_SCALE) // never past the most
    expect(pinchScale(2, 0, 50)).toBe(2) // fingers on the same spot: no division by zero
  })

  it('allows no movement at normal size and half the extra size when zoomed', () => {
    expect(maxPan(400, 1)).toBe(0)
    expect(maxPan(400, 2)).toBe(200)
    expect(maxPan(400, 3)).toBe(400)
  })

  it('keeps a zoomed picture from being dragged out of its box', () => {
    const box = { width: 400, height: 300 }
    expect(clampPan({ x: 50, y: -50 }, box, 1)).toEqual({ x: 0, y: 0 })
    expect(clampPan({ x: 999, y: -999 }, box, 2)).toEqual({ x: 200, y: -150 })
    expect(clampPan({ x: 30, y: -20 }, box, 2)).toEqual({ x: 30, y: -20 })
    expect(clampPan({ x: 1, y: 1 }, { width: 0, height: 0 }, 3)).toEqual({ x: 0, y: 0 })
  })

  it('tells a double tap from two taps far apart in time or place', () => {
    const first = { at: 1000, x: 100, y: 100 }
    expect(isDoubleTap(null, first)).toBe(false)
    expect(isDoubleTap(first, { at: 1200, x: 105, y: 98 })).toBe(true)
    expect(isDoubleTap(first, { at: 1500, x: 100, y: 100 })).toBe(false)
    expect(isDoubleTap(first, { at: 1100, x: 300, y: 100 })).toBe(false)
  })
})
