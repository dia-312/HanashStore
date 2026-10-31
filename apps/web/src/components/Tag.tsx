import type { ReactNode } from 'react'

// A small label with its own shape and text: never colour alone (CLAUDE.md).
const LOOK = {
  good: { shape: '✓', classes: 'border-green-700 bg-green-50 text-green-900' },
  wait: { shape: '◔', classes: 'border-amber-700 bg-amber-50 text-amber-900' },
  bad: { shape: '✕', classes: 'border-red-700 bg-red-50 text-red-900' },
  plain: { shape: '○', classes: 'border-navy/40 bg-white text-navy' },
} as const

export function Tag({ kind, children }: { kind: keyof typeof LOOK; children: ReactNode }) {
  const { shape, classes } = LOOK[kind]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm font-bold ${classes}`}
    >
      <span aria-hidden="true">{shape}</span>
      {children}
    </span>
  )
}
