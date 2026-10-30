import { ar } from '../i18n/ar'

export function OfflineNotice() {
  return (
    <p role="status" className="rounded-xl border-2 border-dashed border-navy/40 p-4 font-bold">
      <span aria-hidden="true">○ </span>
      {ar.needsInternet}
    </p>
  )
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <p role="alert" className="flex flex-wrap items-center gap-3 font-bold text-red-700">
      <span>
        <span aria-hidden="true">⚠ </span>
        {message}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-11 rounded-xl border-2 border-navy/30 bg-white px-4 text-navy"
        >
          {ar.form.retry}
        </button>
      )}
    </p>
  )
}
