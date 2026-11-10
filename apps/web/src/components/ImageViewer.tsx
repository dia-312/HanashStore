import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ar, fill } from '../i18n/ar'
import {
  DOUBLE_TAP_SCALE,
  MIN_SCALE,
  clampPan,
  distance,
  isDoubleTap,
  pinchScale,
  type Point,
} from '../lib/zoom'
import { Icon } from './Icon'

// A picture, or all the pictures of a product, over the whole screen: swipe between them, pinch or
// double tap to zoom, drag a zoomed picture to look around, the big button (or Escape) to close. It
// only reads the picture addresses it is given; nothing is stored or sent.

export interface ViewerImage {
  id: string
  url: string
}

const IDENTITY = { scale: 1, x: 0, y: 0 }

function Zoomable({
  src,
  alt,
  active,
  onZoomed,
}: {
  src: string
  alt: string
  active: boolean
  onZoomed: (zoomed: boolean) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState(IDENTITY)
  const [wasActive, setWasActive] = useState(active)
  const pointers = useRef(new Map<number, Point>())
  const pinch = useRef<{ distance: number; scale: number } | null>(null)
  const drag = useRef<{ from: Point; x: number; y: number } | null>(null)
  const tapStart = useRef<Point | null>(null)
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null)
  const moved = useRef(false)

  // A picture that is scrolled out of sight goes back to its normal size.
  if (active !== wasActive) {
    setWasActive(active)
    if (!active) setView(IDENTITY)
  }

  const zoomed = active && view.scale > MIN_SCALE
  useEffect(() => {
    onZoomed(zoomed)
  }, [zoomed, onZoomed])

  const boxSize = () => {
    const rect = box.current?.getBoundingClientRect()
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 }
  }
  const here = (e: ReactPointerEvent): Point => ({ x: e.clientX, y: e.clientY })
  const fingers = () => [...pointers.current.values()] as [Point, Point]

  const down = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, here(e))
    if (pointers.current.size === 1) {
      moved.current = false
      tapStart.current = here(e)
    }
    if (pointers.current.size === 2) {
      const [a, b] = fingers()
      pinch.current = { distance: distance(a, b), scale: view.scale }
      drag.current = null
      moved.current = true
    } else if (view.scale > MIN_SCALE) {
      drag.current = { from: here(e), x: view.x, y: view.y }
    }
  }

  const move = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, here(e))
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = fingers()
      const scale = pinchScale(pinch.current.scale, pinch.current.distance, distance(a, b))
      setView((v) => ({ scale, ...clampPan(v, boxSize(), scale) }))
    } else if (drag.current) {
      const start = drag.current
      const dx = e.clientX - start.from.x
      const dy = e.clientY - start.from.y
      if (Math.hypot(dx, dy) > 6) moved.current = true
      setView((v) => ({
        scale: v.scale,
        ...clampPan({ x: start.x + dx, y: start.y + dy }, boxSize(), v.scale),
      }))
    }
  }

  const up = (e: ReactPointerEvent) => {
    const wasPinching = pinch.current !== null
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) {
      drag.current = null
      const start = tapStart.current
      const isTap =
        e.type === 'pointerup' &&
        !wasPinching &&
        !moved.current &&
        start &&
        distance(start, here(e)) <= 10
      if (isTap) {
        const now = { at: Date.now(), ...here(e) }
        if (isDoubleTap(lastTap.current, now)) {
          lastTap.current = null
          setView((v) => (v.scale > MIN_SCALE ? IDENTITY : { scale: DOUBLE_TAP_SCALE, x: 0, y: 0 }))
        } else {
          lastTap.current = now
        }
      }
      // A zoom that was let go of almost at normal size is normal size.
      setView((v) => (v.scale < 1.05 ? IDENTITY : v))
    } else if (pointers.current.size === 1 && view.scale > MIN_SCALE) {
      // One finger is left after a pinch: carry on as a drag from where it is.
      drag.current = { from: fingers()[0], x: view.x, y: view.y }
    }
  }

  return (
    <div
      ref={box}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      style={{ touchAction: zoomed ? 'none' : 'pan-x' }}
      className="grid size-full select-none place-items-center overflow-hidden"
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          willChange: 'transform',
        }}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  )
}

export default function ImageViewer({
  images,
  alt,
  start,
  onClose,
}: {
  images: ViewerImage[]
  alt: string
  start: number
  onClose: () => void
}) {
  const rail = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [index, setIndex] = useState(start)
  const [zoomed, setZoomed] = useState(false)
  const last = images.length - 1

  useLayoutEffect(() => {
    rail.current?.children[start]?.scrollIntoView?.({ inline: 'center', block: 'nearest' })
  }, [start])

  // While it is open the page behind does not scroll; closing puts the focus back on what opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    return () => {
      document.body.style.overflow = overflow
      opener?.focus?.()
    }
  }, [])

  const go = useCallback(
    (to: number) => {
      const at = Math.min(last, Math.max(0, to))
      rail.current?.children[at]?.scrollIntoView?.({
        behavior: 'smooth',
        inline: 'center',
        block: 'nearest',
      })
      setIndex(at)
    },
    [last],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft')
        go(index + 1) // the pictures run from right to left
      else if (e.key === 'ArrowRight') go(index - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, index, onClose])

  const arrow =
    'absolute top-1/2 grid size-12 -translate-y-1/2 place-items-center rounded-full bg-cream/20 text-cream outline-accent focus-visible:outline-4 disabled:opacity-30'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-50 flex flex-col bg-navy text-cream"
    >
      <div className="flex items-center justify-between gap-3 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          ref={closeButton}
          type="button"
          onClick={onClose}
          className="min-h-12 rounded-xl bg-cream/15 px-5 text-lg font-bold outline-accent focus-visible:outline-4"
        >
          {ar.present.close}
        </button>
        {images.length > 1 && (
          <bdi className="text-lg font-bold">
            {fill(ar.present.pictureOf, { n: index + 1, total: images.length })}
          </bdi>
        )}
      </div>
      <div className="relative min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]">
        <div
          ref={rail}
          onScroll={(e) => {
            const el = e.currentTarget
            if (el.clientWidth > 0) setIndex(Math.round(Math.abs(el.scrollLeft) / el.clientWidth))
          }}
          style={{ overflowX: zoomed ? 'hidden' : 'auto' }}
          className="flex h-full snap-x snap-mandatory"
        >
          {images.map((image, at) => (
            <div key={image.id} className="h-full w-full shrink-0 snap-center">
              <Zoomable src={image.url} alt={alt} active={at === index} onZoomed={setZoomed} />
            </div>
          ))}
        </div>
        {images.length > 1 && (
          <>
            <button
              type="button"
              aria-label={ar.present.prevPicture}
              disabled={index === 0}
              onClick={() => go(index - 1)}
              className={`${arrow} start-2`}
            >
              <Icon name="forward" className="size-6 rotate-180" />
            </button>
            <button
              type="button"
              aria-label={ar.present.nextPicture}
              disabled={index === last}
              onClick={() => go(index + 1)}
              className={`${arrow} end-2`}
            >
              <Icon name="forward" className="size-6" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
