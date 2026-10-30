import { useEffect, useState } from 'react'
import { useImages, redownloadAllImages, refreshImageProgress } from '../lib/sync/images'
import { Link } from 'react-router'
import { ar, fill } from '../i18n/ar'
import { PENDING_COMMANDS, useAuth } from '../store'
import { SetPin } from './SetPin'

const button = 'min-h-12 rounded-xl border-2 border-navy/30 bg-white px-4 font-bold'

export default function Settings() {
  const { identity, lock, logout, logoutAll } = useAuth()
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [changingPin, setChangingPin] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const images = useImages()

  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(false))
    void refreshImageProgress()
  }, [])

  const run = async (action: () => Promise<void>) => {
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(
        e instanceof Error && e.message === PENDING_COMMANDS
          ? ar.settings.logoutPending
          : ar.settings.logoutFailed,
      )
    }
  }

  if (changingPin) return <SetPin onDone={() => setChangingPin(false)} />

  return (
    <section className="max-w-xl">
      <h2 className="mb-4 text-2xl font-bold">{ar.settings.title}</h2>
      <dl className="mb-6 grid gap-2 rounded-2xl bg-white p-4">
        <div className="flex justify-between gap-4">
          <dt className="font-bold">{ar.settings.device}</dt>
          <dd>{identity?.device.name}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="font-bold">{ar.settings.storage}</dt>
          <dd>
            <span aria-hidden="true">{persisted ? '✓ ' : '✗ '}</span>
            {persisted ? ar.settings.storageOn : ar.settings.storageOff}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="font-bold">{ar.settings.images}</dt>
          <dd>
            <bdi>
              {fill(ar.settings.imagesProgress, { cached: images.cached, total: images.total })}
            </bdi>
            {images.running && ` · ${ar.settings.imagesRunning}`}
          </dd>
        </div>
      </dl>
      {error && (
        <p role="alert" className="mb-4 font-bold text-red-700">
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      )}
      <div className="grid gap-3">
        <Link to="/sync" className={`${button} flex items-center`}>
          {ar.settings.sync}
        </Link>
        <button
          type="button"
          className={button}
          disabled={images.running}
          onClick={() => void redownloadAllImages()}
        >
          {ar.settings.redownload}
        </button>
        <Link to="/settings/categories" className={`${button} flex items-center`}>
          {ar.settings.categories}
        </Link>
        <Link to="/settings/import" className={`${button} flex items-center`}>
          {ar.settings.importProducts}
        </Link>
        <button type="button" className={button} onClick={lock}>
          {ar.settings.lockNow}
        </button>
        <button type="button" className={button} onClick={() => setChangingPin(true)}>
          {ar.settings.changePin}
        </button>
        <button type="button" className={button} onClick={() => run(logout)}>
          {ar.settings.logout}
        </button>
        <button type="button" className={button} onClick={() => run(logoutAll)}>
          {ar.settings.logoutAll}
        </button>
      </div>
    </section>
  )
}
