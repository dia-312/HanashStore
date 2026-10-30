import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { ar, fill } from '../i18n/ar'
import { ApiError } from '../lib/api'
import { useAuth } from '../store'

const schema = z.object({ password: z.string().min(1, ar.login.required).max(256) })

interface Props {
  /** Used by the lock screen: log in again with the password instead of the PIN. */
  submitLabel?: string
  onSubmit?: (password: string) => Promise<void>
}

export function Login({ submitLabel = ar.login.submit, onSubmit }: Props) {
  const login = useAuth((s) => s.login)
  const [error, setError] = useState<string | null>(null)
  const [replace, setReplace] = useState<{ name: string; password: string } | null>(null)
  const {
    register,
    handleSubmit,
    formState: { isSubmitting, errors },
  } = useForm<{ password: string }>({})

  const attempt = async (password: string, confirmReplace = false) => {
    setError(null)
    try {
      await (onSubmit ? onSubmit(password) : login(password, confirmReplace))
      setReplace(null)
    } catch (e) {
      if (!(e instanceof ApiError)) return setError(ar.login.failed)
      if (e.code === 'DEVICE_REPLACE_CONFIRM') {
        const device = e.details.active_device as { name: string } | undefined
        setReplace({ name: device?.name ?? '', password })
      } else if (e.code === 'INVALID_CREDENTIALS') setError(ar.login.wrongPassword)
      else if (e.code === 'RATE_LIMITED') {
        const wait = Number(e.details.retry_after ?? 60)
        setError(fill(ar.login.tooMany, { minutes: Math.ceil(wait / 60) }))
      } else if (e.code === 'NETWORK') setError(ar.login.offline)
      else setError(ar.login.failed)
    }
  }

  return (
    <main className="grid min-h-full place-items-center p-6">
      <form
        className="w-full max-w-sm rounded-3xl bg-white p-8 shadow-sm"
        onSubmit={handleSubmit((v) => {
          const parsed = schema.safeParse(v)
          if (parsed.success) return attempt(parsed.data.password)
          setError(parsed.error.issues[0]?.message ?? ar.login.required)
        })}
      >
        <h1 className="mb-6 text-2xl font-bold">{ar.login.title}</h1>
        <label className="mb-2 block font-bold" htmlFor="password">
          {ar.login.passwordLabel}
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          className="mb-4 min-h-12 w-full rounded-xl border-2 border-navy/30 px-4 text-lg"
          {...register('password')}
        />
        {(error || errors.password) && (
          <p role="alert" className="mb-4 font-bold text-red-700">
            <span aria-hidden="true">⚠ </span>
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={isSubmitting}
          className="min-h-12 w-full rounded-xl bg-navy px-4 text-lg font-bold text-white disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </form>

      {replace && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 grid place-items-center bg-navy/60 p-6"
        >
          <div className="w-full max-w-sm rounded-3xl bg-white p-6">
            <h2 className="mb-2 text-xl font-bold">{ar.login.replaceTitle}</h2>
            <p className="mb-6">{fill(ar.login.replaceBody, { name: replace.name })}</p>
            <div className="flex gap-3">
              <button
                type="button"
                className="min-h-12 flex-1 rounded-xl bg-accent px-4 font-bold text-white"
                onClick={() => attempt(replace.password, true)}
              >
                {ar.login.replaceConfirm}
              </button>
              <button
                type="button"
                className="min-h-12 rounded-xl border-2 border-navy/30 px-4 font-bold"
                onClick={() => setReplace(null)}
              >
                {ar.common.cancel}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
