// The arithmetic of the picture viewer's pinch and drag, kept apart from the screen so it can be tested.

export const MIN_SCALE = 1
export const MAX_SCALE = 4
/** What a double tap zooms to (a second double tap goes back to MIN_SCALE). */
export const DOUBLE_TAP_SCALE = 2.5

export interface Point {
  x: number
  y: number
}

export const clampScale = (scale: number): number =>
  Number.isFinite(scale) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) : MIN_SCALE

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)

/** The new zoom while two fingers move: the start zoom times how much the fingers spread or closed. */
export const pinchScale = (
  startScale: number,
  startDistance: number,
  nowDistance: number,
): number => clampScale(startDistance > 0 ? startScale * (nowDistance / startDistance) : startScale)

/** How far a picture of this size can be moved from the centre in one direction at this zoom. */
export const maxPan = (size: number, scale: number): number =>
  Math.max(0, (size * scale - size) / 2)

/** Keeps the picture from being dragged out of its box: it can never leave an empty edge showing
 * inside the box while it is zoomed, and at zoom 1 it does not move at all. */
export function clampPan(pan: Point, box: { width: number; height: number }, scale: number): Point {
  const limitX = maxPan(box.width, scale)
  const limitY = maxPan(box.height, scale)
  return {
    // + 0 turns a -0 into 0
    x: Math.min(limitX, Math.max(-limitX, pan.x)) + 0,
    y: Math.min(limitY, Math.max(-limitY, pan.y)) + 0,
  }
}

/** A tap is a double tap when it comes soon after the last one and close to it. */
export function isDoubleTap(
  last: { at: number; x: number; y: number } | null,
  now: { at: number; x: number; y: number },
  withinMs = 300,
  withinPx = 30,
): boolean {
  return last !== null && now.at - last.at <= withinMs && distance(last, now) <= withinPx
}
