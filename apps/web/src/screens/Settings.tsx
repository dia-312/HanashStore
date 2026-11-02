import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Icon, type IconName } from '../components/Icon'
import { ar, fill } from '../i18n/ar'
import { APP_VERSION, COPYRIGHT_YEAR, DEVELOPER } from '../lib/about'
import { readPerf } from '../lib/perf'
import { redownloadAllImages, refreshImageProgress, useImages } from '../lib/sync/images'
import { useLive } from '../lib/useLive'
import { PENDING_COMMANDS, useAuth } from '../store'
import { SetPin } from './SetPin'

// Settings, in groups. One row is one thing the rep can do or see: an icon, what it is called, one
// line saying what it is for, and an arrow when it opens another screen. Rows are at least 64 px
// tall (a thumb, not a mouse). What is dangerous (signing out) sits last, in its own group, and says
// so with a symbol and words, never by colour alone.

const row =
  'flex min-h-16 w-full items-center gap-3 px-4 py-3 text-start outline-accent focus-visible:outline-4 focus-visible:-outline-offset-4 active:bg-navy/5 disabled:opacity-50'

function Chip({ icon, danger }: { icon: IconName; danger?: boolean }) {
  return (
    <span
      className={`grid size-11 shrink-0 place-items-center rounded-xl ${
        danger ? 'bg-red-50 text-red-800' : 'bg-navy/10 text-navy'
      }`}
    >
      <Icon name={icon} />
    </span>
  )
}

function Words({ title, hint }: { title: string; hint?: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block text-lg font-bold leading-snug">{title}</span>
      {hint && <span className="block text-sm leading-relaxed opacity-75">{hint}</span>}
    </span>
  )
}

function LinkRow({
  to,
  icon,
  title,
  hint,
}: {
  to: string
  icon: IconName
  title: string
  hint?: string
}) {
  return (
    <Link to={to} className={row}>
      <Chip icon={icon} />
      <Words title={title} hint={hint} />
      <Icon name="forward" className="size-5 shrink-0 opacity-50" />
    </Link>
  )
}

function ActionRow({
  icon,
  title,
  hint,
  onClick,
  danger,
  disabled,
}: {
  icon: IconName
  title: string
  hint?: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button type="button" className={row} onClick={onClick} disabled={disabled}>
      <Chip icon={icon} danger={danger} />
      <span className="min-w-0 flex-1">
        <span className={`block text-lg font-bold leading-snug ${danger ? 'text-red-800' : ''}`}>
          {danger && <span aria-hidden="true">⚠ </span>}
          {title}
        </span>
        {hint && <span className="block text-sm leading-relaxed opacity-75">{hint}</span>}
      </span>
    </button>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = `group-${title.replace(/\s+/g, '-')}`
  return (
    <section aria-labelledby={id} className="grid content-start gap-2">
      <h3 id={id} className="px-1 text-base font-bold opacity-70">
        {title}
      </h3>
      <div className="overflow-hidden rounded-2xl bg-white shadow-sm [&>*+*]:border-t [&>*+*]:border-navy/10">
        {children}
      </div>
    </section>
  )
}

/** A line of information that does nothing when tapped. */
function Fact({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-16 items-center gap-3 px-4 py-3">
      <Chip icon={icon} />
      <span className="min-w-0 flex-1">
        <span className="block text-lg font-bold leading-snug">{title}</span>
        <span className="block text-sm leading-relaxed opacity-80">{children}</span>
      </span>
    </div>
  )
}

export default function Settings() {
  const { identity, lock, logout, logoutAll } = useAuth()
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [changingPin, setChangingPin] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const images = useImages()
  const perf = useLive(async () => (await readPerf()) ?? {}, [])

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

  const percent = images.total > 0 ? Math.round((images.cached * 100) / images.total) : 0
  const ms = (n: number | undefined) =>
    n === undefined ? ar.settings.perfNone : fill(ar.settings.ms, { n })

  return (
    <section className="mx-auto grid max-w-5xl gap-5 pb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-2xl font-bold">{ar.settings.title}</h2>
        {identity && (
          <p className="opacity-75">
            {ar.settings.signedInAs} <bdi className="font-bold">{identity.user.name}</bdi>
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-xl bg-white p-3 font-bold text-red-800">
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Group title={ar.settings.groupShop}>
          <LinkRow
            to="/settings/business"
            icon="building"
            title={ar.settings.business}
            hint={ar.settings.businessHint}
          />
          <LinkRow
            to="/settings/categories"
            icon="tag"
            title={ar.settings.categories}
            hint={ar.settings.categoriesHint}
          />
          <LinkRow
            to="/settings/synonyms"
            icon="words"
            title={ar.settings.synonyms}
            hint={ar.settings.synonymsHint}
          />
          <LinkRow
            to="/settings/import"
            icon="import"
            title={ar.settings.importProducts}
            hint={ar.settings.importHint}
          />
        </Group>

        <Group title={ar.settings.groupData}>
          <LinkRow
            to="/settings/export"
            icon="export"
            title={ar.settings.exportData}
            hint={ar.settings.exportHint}
          />
          <LinkRow to="/sync" icon="sync" title={ar.settings.sync} hint={ar.settings.syncHint} />
          <div className="flex min-h-16 items-center gap-3 px-4 py-3">
            <Chip icon="image" />
            <span className="min-w-0 flex-1">
              <span className="block text-lg font-bold leading-snug">{ar.settings.images}</span>
              <span className="block text-sm opacity-80">
                <bdi>
                  {fill(ar.settings.imagesProgress, {
                    cached: images.cached,
                    total: images.total,
                  })}
                </bdi>
                {images.running && ` · ${ar.settings.imagesRunning}`}
              </span>
              <span
                role="progressbar"
                aria-label={ar.settings.images}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="mt-2 block h-2 overflow-hidden rounded-full bg-navy/10"
              >
                <span className="block h-full bg-navy" style={{ width: `${percent}%` }} />
              </span>
            </span>
          </div>
          <ActionRow
            icon="image"
            title={ar.settings.redownload}
            disabled={images.running}
            onClick={() => void redownloadAllImages()}
          />
        </Group>

        <Group title={ar.settings.groupSecurity}>
          <ActionRow
            icon="pin"
            title={ar.settings.changePin}
            hint={ar.settings.changePinHint}
            onClick={() => setChangingPin(true)}
          />
          <ActionRow
            icon="lock"
            title={ar.settings.lockNow}
            hint={ar.settings.lockHint}
            onClick={lock}
          />
        </Group>

        <Group title={ar.settings.groupDevice}>
          <Fact icon="tablet" title={ar.settings.device}>
            <bdi>{identity?.device.name}</bdi>
          </Fact>
          <Fact icon="disk" title={ar.settings.storage}>
            <span aria-hidden="true">{persisted ? '✓ ' : '✗ '}</span>
            {persisted ? ar.settings.storageOn : ar.settings.storageOff}
          </Fact>
          <Fact icon="gauge" title={ar.settings.perfTitle}>
            {ar.settings.perfCatalog}: <bdi>{ms(perf?.catalogOpenMs)}</bdi>
            {' · '}
            {ar.settings.perfFirstSync}: <bdi>{ms(perf?.firstSyncMs)}</bdi>
          </Fact>
        </Group>

        <Group title={ar.settings.groupSignOut}>
          <ActionRow
            icon="logout"
            danger
            title={ar.settings.logout}
            hint={ar.settings.logoutHint}
            onClick={() => void run(logout)}
          />
          <ActionRow
            icon="devices"
            danger
            title={ar.settings.logoutAll}
            hint={ar.settings.logoutAllHint}
            onClick={() => void run(logoutAll)}
          />
        </Group>

        <section aria-labelledby="about" className="grid content-start gap-2">
          <h3 id="about" className="px-1 text-base font-bold opacity-70">
            {ar.settings.about}
          </h3>
          <div className="grid gap-3 rounded-2xl bg-navy p-5 text-cream shadow-sm">
            <div className="flex items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-cream/15">
                <Icon name="info" />
              </span>
              <span>
                <span className="block text-lg font-bold leading-snug">{ar.settings.appName}</span>
                <span className="block text-sm opacity-80">
                  {ar.settings.version} <bdi dir="ltr">{APP_VERSION}</bdi>
                </span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-cream/15">
                <Icon name="code" />
              </span>
              <span>
                <span className="block text-sm opacity-80">{ar.settings.developedBy}</span>
                <span className="block text-lg font-bold leading-snug">
                  {DEVELOPER.ar} <bdi dir="ltr">· {DEVELOPER.en}</bdi>
                </span>
              </span>
            </div>
            <p className="border-t border-cream/20 pt-3 text-sm leading-relaxed">
              © <bdi>{COPYRIGHT_YEAR}</bdi> {DEVELOPER.ar}. {ar.settings.rights}
            </p>
          </div>
        </section>
      </div>
    </section>
  )
}
