import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useState, type ReactNode } from 'react'

/** Width of an element that may only appear after data loads: pass the element itself (kept in
 * state through a callback ref), not a ref object, so the observer starts when it mounts. */
function useWidth(element: HTMLElement | null) {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return width
}

/**
 * A grid of tiles that draws only the rows on screen (SPEC section 17): a catalog of hundreds of
 * products never puts hundreds of pictures in the page at once. The number of columns follows the
 * width, so an iPad shows 3 in portrait and 4 in landscape with the default tile width.
 */
export function VirtualGrid<T>({
  items,
  keyOf,
  render,
  minColumnWidth = 270,
  captionHeight = 150,
  gap = 16,
}: {
  items: T[]
  keyOf: (item: T) => string
  render: (item: T) => ReactNode
  minColumnWidth?: number
  /** Height of what sits under each square picture, for the first guess before rows are measured. */
  captionHeight?: number
  gap?: number
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const width = useWidth(scroller)
  const columns = Math.max(2, Math.floor((width + gap) / (minColumnWidth + gap)))
  const columnWidth = width > 0 ? (width - gap * (columns - 1)) / columns : minColumnWidth
  const rows = Math.ceil(items.length / columns)

  // TanStack's virtualizer is not memoizable by the React compiler; nothing here relies on that.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scroller,
    estimateSize: () => columnWidth + captionHeight + gap,
    overscan: 2,
    // Until the box is measured, assume it is as tall as the window: the first frame has rows.
    initialRect: { width: 0, height: window.innerHeight },
  })

  return (
    <div ref={setScroller} className="min-h-0 flex-1 overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtualizer.measureElement}
            className="absolute start-0 top-0 w-full"
            style={{ transform: `translateY(${row.start}px)`, paddingBottom: gap }}
          >
            <div
              className="grid"
              style={{ gap, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {items.slice(row.index * columns, (row.index + 1) * columns).map((item) => (
                <div key={keyOf(item)}>{render(item)}</div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
