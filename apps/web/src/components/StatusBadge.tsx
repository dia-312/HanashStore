import type { ReactNode } from 'react'
import type { StockStatus } from '../lib/catalogApi'

// Never colour alone (CLAUDE.md): every state has its own shape and a text label.
const LOOK: Record<StockStatus | 'none', { shape: string; classes: string }> = {
  ok: { shape: '●', classes: 'border-green-700 bg-green-50 text-green-900' },
  low: { shape: '▲', classes: 'border-amber-700 bg-amber-50 text-amber-900' },
  out: { shape: '✕', classes: 'border-red-700 bg-red-50 text-red-900' },
  none: { shape: '○', classes: 'border-navy/40 bg-white text-navy' },
}

export function StatusBadge({
  status,
  children,
}: {
  status: StockStatus | 'none'
  children: ReactNode
}) {
  const { shape, classes } = LOOK[status]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm font-bold ${classes}`}
    >
      <span aria-hidden="true">{shape}</span>
      {children}
    </span>
  )
}
