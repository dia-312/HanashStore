import { useState } from 'react'
import { ar, fill } from '../i18n/ar'
import { remainingLockMs } from '../lib/lock'
import { PinPad } from '../screens/PinPad'
import { useAuth } from '../store'

/**
 * Asks for the PIN before the rep takes over from the customer (presentation mode exit and
 * checkout, SPEC section 10). It uses the same attempt counting and lockout as the lock screen;
 * after too many wrong tries the whole app locks and asks for the password.
 */
export function PinGate({
  title,
  onSuccess,
  onCancel,
}: {
  title: string
  onSuccess: () => void
  onCancel: () => void
}) {
  const { attempts, pinLength, unlock, lock } = useAuth()
  const [message, setMessage] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  const waitMs = remainingLockMs(attempts, now)

  const submit = async (pin: string) => {
    const result = await unlock(pin)
    setNow(Date.now())
    setRound((r) => r + 1)
    if (result === 'ok') return onSuccess()
    if (result === 'password') return lock() // too many wrong PINs: the lock screen asks for the password
    setMessage(result === 'wrong' ? ar.lock.wrong : null)
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-navy/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-gate-title"
        className="w-full max-w-sm rounded-2xl bg-cream p-6 text-center shadow-xl"
      >
        <h2 id="pin-gate-title" className="mb-1 text-xl font-bold">
          <span aria-hidden="true">🔒 </span>
          {title}
        </h2>
        <p className="mb-4">{ar.present.exitHint}</p>
        {waitMs > 0 ? (
          <p role="alert" className="mb-3 font-bold text-red-700">
            <span aria-hidden="true">⚠ </span>
            {fill(ar.lock.lockedFor, { minutes: Math.ceil(waitMs / 60_000) })}
          </p>
        ) : (
          message && (
            <p role="alert" className="mb-3 font-bold text-red-700">
              <span aria-hidden="true">⚠ </span>
              {message}
            </p>
          )
        )}
        <PinPad onComplete={submit} length={pinLength} disabled={waitMs > 0} key={round} />
        <button
          type="button"
          onClick={onCancel}
          className="mt-4 min-h-12 rounded-xl border-2 border-navy/30 bg-white px-6 font-bold"
        >
          {ar.common.cancel}
        </button>
      </div>
    </div>
  )
}
