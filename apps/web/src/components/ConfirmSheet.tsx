import { useEffect, type ReactNode } from 'react'
import { ar } from '../i18n/ar'

interface Props {
  title: string
  /** The numbers the rep is about to commit to (SPEC section 14: every action shows its amounts). */
  lines?: { label: string; value: string }[]
  message?: string
  confirmLabel: string
  busy?: boolean
  error?: string | null
  /** Extra content between the numbers and the buttons (a reason field, a question). */
  children?: ReactNode
  /** The confirm button stays off until the extra content is filled in. */
  confirmDisabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmSheet({
  title,
  lines = [],
  message,
  confirmLabel,
  busy,
  error,
  children,
  confirmDisabled,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !busy && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy/50 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-lg rounded-t-2xl bg-cream p-6 shadow-xl sm:rounded-2xl"
      >
        <h2 id="confirm-title" className="mb-3 text-xl font-bold">
          {title}
        </h2>
        {message && <p className="mb-3">{message}</p>}
        {lines.length > 0 && (
          <dl className="mb-4 grid gap-2 rounded-xl bg-white p-3">
            {lines.map((line) => (
              <div key={line.label} className="flex justify-between gap-4">
                <dt>{line.label}</dt>
                <dd className="font-bold">
                  <bdi>{line.value}</bdi>
                </dd>
              </div>
            ))}
          </dl>
        )}
        {children}
        {error && (
          <p role="alert" className="mb-3 font-bold text-red-700">
            <span aria-hidden="true">⚠ </span>
            {error}
          </p>
        )}
        <div className="flex gap-3">
          <button
            type="button"
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
            className="min-h-12 flex-1 rounded-xl bg-navy px-4 font-bold text-white disabled:opacity-50"
          >
            {busy ? ar.form.saving : confirmLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            autoFocus
            className="min-h-12 rounded-xl border-2 border-navy/30 bg-white px-4 font-bold disabled:opacity-50"
          >
            {ar.common.cancel}
          </button>
        </div>
      </div>
    </div>
  )
}
