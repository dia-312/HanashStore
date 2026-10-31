import { useVirtualizer } from '@tanstack/react-virtual'
import { useState, type ReactNode } from 'react'

/** A long vertical list that only renders the rows on screen (SPEC section 17). */
export function VirtualRows<T>({
  items,
  estimate,
  keyOf,
  render,
}: {
  items: T[]
  estimate: number
  keyOf: (item: T) => string
  render: (item: T) => ReactNode
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  // TanStack's virtualizer is not memoizable by the React compiler; nothing here relies on that.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller,
    estimateSize: () => estimate,
    overscan: 6,
    // Until the box is measured, assume it is as tall as the window: the first frame has rows.
    initialRect: { width: 0, height: window.innerHeight },
  })
  return (
    <div ref={setScroller} className="min-h-0 flex-1 overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index]!
          return (
            <div
              key={keyOf(item)}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className="absolute start-0 top-0 w-full pb-2"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {render(item)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
