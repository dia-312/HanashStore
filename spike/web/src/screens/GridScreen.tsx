import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { db, saveResult, type Variant } from '../db'
import { fmtMoney } from '../format'

const GAP = 12
const TEXT_H = 76

const Cell = memo(function Cell({ v }: { v: Variant }) {
  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-sm">
      <img
        src={v.thumb}
        width={400}
        height={400}
        loading="lazy"
        decoding="async"
        alt=""
        className="aspect-square w-full bg-slate-200 object-cover"
      />
      <div className="p-2 text-sm leading-tight" style={{ height: TEXT_H }}>
        <div className="truncate font-bold">{v.name}</div>
        <div className="truncate text-slate-500">{v.color} · {v.size}</div>
        <div dir="ltr" className="mt-1 text-end font-bold text-[#F28C28]">{fmtMoney(v.price)}</div>
      </div>
    </div>
  )
})

interface Fps { avg: number; min: number; long: number; frames: number }

function useFpsMeter(el: React.RefObject<HTMLDivElement | null>) {
  const [stats, setStats] = useState<Fps | null>(null)
  useEffect(() => {
    const node = el.current
    if (!node) return
    let raf = 0
    let last = 0
    let active = false
    let idle = 0
    let deltas: number[] = []
    const tick = (t: number) => {
      if (last) deltas.push(t - last)
      last = t
      raf = requestAnimationFrame(tick)
    }
    const stop = () => {
      cancelAnimationFrame(raf)
      active = false
      last = 0
      if (deltas.length > 5) {
        const sum = deltas.reduce((a, b) => a + b, 0)
        setStats({
          avg: 1000 / (sum / deltas.length),
          min: 1000 / Math.max(...deltas),
          long: deltas.filter((d) => d > 20).length,
          frames: deltas.length,
        })
      }
      deltas = []
    }
    const onScroll = () => {
      if (!active) { active = true; raf = requestAnimationFrame(tick) }
      clearTimeout(idle)
      idle = window.setTimeout(stop, 200)
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      node.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
      clearTimeout(idle)
    }
  }, [el])
  return stats
}

function useColumns() {
  const get = () => (window.innerWidth > window.innerHeight ? 4 : 3)
  const [cols, setCols] = useState(get)
  useEffect(() => {
    const f = () => setCols(get())
    window.addEventListener('resize', f)
    return () => window.removeEventListener('resize', f)
  }, [])
  return cols
}

export function GridScreen() {
  const mountAt = useRef(performance.now())
  const scrollRef = useRef<HTMLDivElement>(null)
  const cols = useColumns()
  const [rows, setRows] = useState<Variant[]>([])
  const [width, setWidth] = useState(0)
  const [status, setStatus] = useState('loading…')
  const [openMs, setOpenMs] = useState<{ fromMount: number; fromNav: number } | null>(null)
  const [prefetch, setPrefetch] = useState({ done: 0, total: 0, failed: 0 })
  const fps = useFpsMeter(scrollRef)

  // Load from Dexie; seed from /media/variants.json only on the very first run.
  useEffect(() => {
    let alive = true
    ;(async () => {
      let all = await db.variants.toArray()
      if (all.length === 0) {
        setStatus('seeding Dexie from /media/variants.json…')
        const res = await fetch('/media/variants.json')
        if (!res.ok) { setStatus(`seed failed: HTTP ${res.status} (run the seed script)`); return }
        await db.variants.bulkPut((await res.json()) as Variant[])
        mountAt.current = performance.now() // measure the warm open, not the one-time seed
        all = await db.variants.toArray()
      }
      if (alive) { setRows(all); setStatus(`${all.length} variants from IndexedDB`) }
    })().catch((e) => setStatus(`error: ${String(e)}`))
    return () => { alive = false }
  }, [])

  // Time from opening the screen (or process start, for fromNav) to the first painted grid.
  useEffect(() => {
    if (rows.length === 0 || openMs) return
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const now = performance.now()
      const m = { fromMount: Math.round(now - mountAt.current), fromNav: Math.round(now) }
      setOpenMs(m)
      saveResult('metric:grid-open', {
        note: `${m.fromMount} ms mount->paint, ${m.fromNav} ms since navigation start, ${cols} cols, ${rows.length} items`,
      })
    }))
  }, [rows, openMs, cols])

  useEffect(() => {
    if (fps) {
      saveResult('metric:grid-scroll', {
        note: `avg ${fps.avg.toFixed(0)} fps, min ${fps.min.toFixed(0)} fps, ${fps.long}/${fps.frames} frames > 20 ms`,
      })
    }
  }, [fps])

  // Cache every thumbnail (4 in parallel, SPEC section 17) so the grid works offline from a cold start.
  useEffect(() => {
    if (rows.length === 0 || !navigator.onLine) return
    const urls = [...new Set(rows.map((r) => r.thumb))]
    setPrefetch({ done: 0, total: urls.length, failed: 0 })
    let i = 0
    let alive = true
    const worker = async () => {
      while (alive && i < urls.length) {
        const u = urls[i++]
        try {
          const r = await fetch(u)
          if (!r.ok) throw new Error(String(r.status))
          await r.blob()
          setPrefetch((p) => ({ ...p, done: p.done + 1 }))
        } catch {
          setPrefetch((p) => ({ ...p, failed: p.failed + 1 }))
        }
      }
    }
    for (let k = 0; k < 4; k++) worker()
    return () => { alive = false }
  }, [rows])

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const ro = new ResizeObserver(() => setWidth(node.clientWidth))
    ro.observe(node)
    setWidth(node.clientWidth)
    return () => ro.disconnect()
  }, [])

  const cellW = Math.max(0, (width - GAP * (cols + 1)) / cols)
  const rowH = cellW + TEXT_H + GAP
  const rowCount = Math.ceil(rows.length / cols)

  const virt = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH || 300,
    overscan: 3,
  })
  useEffect(() => { virt.measure() }, [rowH, virt])

  const autoScroll = useCallback(() => {
    const node = scrollRef.current
    if (!node) return
    const total = node.scrollHeight - node.clientHeight
    const start = performance.now()
    const D = 6000
    node.scrollTop = 0
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / D)
      node.scrollTop = total * p
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [])

  const items = virt.getVirtualItems()
  const prefetchLabel = useMemo(
    () => (prefetch.total ? `${prefetch.done}/${prefetch.total} thumbs cached${prefetch.failed ? `, ${prefetch.failed} failed` : ''}` : ''),
    [prefetch],
  )

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-1 bg-white px-3 py-2 text-xs shadow-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>{status}</span>
          {openMs && (
            <bdi dir="ltr" className={`font-bold ${openMs.fromMount < 1000 ? 'text-green-700' : 'text-red-700'}`}>
              open {openMs.fromMount} ms (budget 1000) · since launch {openMs.fromNav} ms
            </bdi>
          )}
          {fps && (
            <bdi dir="ltr" className="font-bold">
              scroll avg {fps.avg.toFixed(0)} fps · min {fps.min.toFixed(0)} · {fps.long}/{fps.frames} frames &gt; 20 ms
            </bdi>
          )}
          <span className="text-slate-500">{prefetchLabel}</span>
        </div>
        <button onClick={autoScroll} className="min-h-11 rounded-lg bg-[#3FA7D6] px-4 font-bold text-white">
          Auto-scroll 6 s (benchmark)
        </button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" style={{ WebkitOverflowScrolling: 'touch', contain: 'strict' }}>
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {items.map((vr) => (
            <div
              key={vr.key}
              style={{
                position: 'absolute', top: 0, insetInlineStart: 0, width: '100%',
                height: rowH, transform: `translateY(${vr.start}px)`,
                display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: GAP,
                paddingInline: GAP, paddingTop: GAP,
              }}
            >
              {rows.slice(vr.index * cols, vr.index * cols + cols).map((v) => <Cell key={v.id} v={v} />)}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
