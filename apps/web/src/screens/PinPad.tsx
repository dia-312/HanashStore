import { useState } from 'react'
import { ar } from '../i18n/ar'

interface Props {
  /** Called with the digits when `length` is reached, or when the rep taps confirm (4-6 digits). */
  onComplete: (pin: string) => void
  /** Known PIN length: submits by itself. Unknown (setting a new PIN): the rep taps confirm. */
  length?: number
  disabled?: boolean
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
const key =
  'min-h-16 min-w-16 rounded-2xl bg-white text-2xl font-bold shadow-sm active:bg-sky/20 disabled:opacity-40'

export function PinPad({ onComplete, length, disabled }: Props) {
  const [digits, setDigits] = useState('')

  const press = (d: string) => {
    if (disabled || digits.length >= 6) return
    const next = digits + d
    setDigits(next)
    if (length && next.length === length) onComplete(next)
  }

  return (
    <div className="mx-auto w-72" dir="ltr">
      {/* One dot per digit: shape, not colour, shows progress. */}
      <div className="mb-6 flex h-6 justify-center gap-3" aria-hidden="true">
        {Array.from({ length: Math.max(length ?? 6, digits.length) }, (_, i) => (
          <span
            key={i}
            className={`size-4 rounded-full border-2 border-navy ${i < digits.length ? 'bg-navy' : ''}`}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {KEYS.map((d) => (
          <button
            key={d}
            type="button"
            className={key}
            disabled={disabled}
            onClick={() => press(d)}
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          className={`${key} text-base`}
          disabled={disabled || digits.length === 0}
          onClick={() => setDigits(digits.slice(0, -1))}
        >
          {ar.pad.delete}
        </button>
        <button type="button" className={key} disabled={disabled} onClick={() => press('0')}>
          0
        </button>
        {length ? (
          <span />
        ) : (
          <button
            type="button"
            className={`${key} bg-accent text-base text-white`}
            disabled={disabled || digits.length < 4}
            onClick={() => onComplete(digits)}
          >
            {ar.pad.confirm}
          </button>
        )}
      </div>
    </div>
  )
}
