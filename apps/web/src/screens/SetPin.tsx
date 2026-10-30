import { useState } from 'react'
import { ar } from '../i18n/ar'
import { useAuth } from '../store'
import { PinPad } from './PinPad'

export function SetPin({ onDone }: { onDone?: () => void }) {
  const savePin = useAuth((s) => s.savePin)
  const [first, setFirst] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  const [busy, setBusy] = useState(false)

  const complete = async (pin: string) => {
    setError(null)
    if (first === null) {
      setFirst(pin)
      setRound((r) => r + 1)
      return
    }
    if (pin !== first) {
      setFirst(null)
      setRound((r) => r + 1)
      return setError(ar.setPin.mismatch)
    }
    setBusy(true)
    try {
      await savePin(pin)
      onDone?.()
    } catch {
      setError(ar.setPin.failed)
      setFirst(null)
      setRound((r) => r + 1)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-full place-items-center p-6 text-center">
      <div>
        <h1 className="mb-2 text-2xl font-bold">
          {first === null ? ar.setPin.title : ar.setPin.confirmTitle}
        </h1>
        <p className="mb-6">{ar.setPin.hint}</p>
        {error && (
          <p role="alert" className="mb-4 font-bold text-red-700">
            <span aria-hidden="true">⚠ </span>
            {error}
          </p>
        )}
        <PinPad onComplete={complete} disabled={busy} key={round} />
      </div>
    </main>
  )
}
