import { useEffect, useState } from 'react'
import { ar, fill } from '../i18n/ar'
import { remainingLockMs } from '../lib/lock'
import { useAuth } from '../store'
import { Login } from './Login'
import { PinPad } from './PinPad'

export function Lock() {
  const { attempts, pinLength, unlock, unlockWithPassword } = useAuth()
  const [message, setMessage] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [usePassword, setUsePassword] = useState(false)

  const waitMs = remainingLockMs(attempts, now)

  // Tick while a lockout runs so the pad re-enables itself.
  useEffect(() => {
    if (!attempts.lockedUntil) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [attempts.lockedUntil])

  if (attempts.requirePassword || usePassword) {
    return (
      <div>
        <p role="alert" className="p-4 text-center font-bold">
          <span aria-hidden="true">⚠ </span>
          {ar.lock.needPassword}
        </p>
        <Login submitLabel={ar.lock.unlockWithPassword} onSubmit={unlockWithPassword} />
      </div>
    )
  }

  const submit = async (pin: string) => {
    const result = await unlock(pin)
    setNow(Date.now())
    setRound((r) => r + 1)
    if (result === 'wrong') setMessage(ar.lock.wrong)
    else if (result === 'password') setUsePassword(true)
    else if (result === 'locked') setMessage(null)
  }

  return (
    <main className="grid min-h-full place-items-center p-6 text-center">
      <div>
        <h1 className="mb-2 text-2xl font-bold">
          <span aria-hidden="true">🔒 </span>
          {ar.lock.title}
        </h1>
        <p className="mb-6">{ar.lock.hint}</p>
        {waitMs > 0 ? (
          <p role="alert" className="mb-4 font-bold text-red-700">
            <span aria-hidden="true">⚠ </span>
            {fill(ar.lock.lockedFor, { minutes: Math.ceil(waitMs / 60_000) })}
          </p>
        ) : (
          message && (
            <p role="alert" className="mb-4 font-bold text-red-700">
              <span aria-hidden="true">⚠ </span>
              {message}
            </p>
          )
        )}
        <PinPad onComplete={submit} length={pinLength} disabled={waitMs > 0} key={round} />
      </div>
    </main>
  )
}
