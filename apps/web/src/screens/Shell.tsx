import { Link, NavLink, Outlet } from 'react-router'
import { ar, fill } from '../i18n/ar'
import { type SyncStatus } from '../lib/sync/engine'
import { useSyncStatus } from '../lib/sync/useSyncStatus'
import { useUpdate } from '../lib/update'
import { useAuth } from '../store'

const NAV = [
  { to: '/', label: ar.nav.home, icon: '⌂', end: true },
  { to: '/catalog', label: ar.nav.catalog, icon: '▦' },
  { to: '/customers', label: ar.nav.customers, icon: '☺' },
  { to: '/invoices', label: ar.nav.invoices, icon: '☰' },
  { to: '/stock', label: ar.nav.stock, icon: '▤' },
  { to: '/reports', label: ar.nav.reports, icon: '◔' },
  { to: '/settings', label: ar.nav.settings, icon: '⚙' },
]

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

function Banner({ children }: { children: string }) {
  return (
    <p role="status" className="bg-accent/20 px-4 py-2 text-sm font-bold">
      <span aria-hidden="true">ⓘ </span>
      {children}
    </p>
  )
}

// Icon + text + shape, never colour alone (CLAUDE rule on status).
const SYNC_ICON: Record<SyncStatus, string> = {
  synced: '✓',
  pending: '◔',
  syncing: '↻',
  offline: '○',
  error: '⚠',
}

function SyncChip() {
  const { status, pending } = useSyncStatus()
  const text =
    status === 'synced'
      ? ar.header.syncSynced
      : status === 'pending'
        ? fill(ar.header.syncPending, { n: pending })
        : status === 'syncing'
          ? ar.header.syncing
          : status === 'offline'
            ? pending > 0
              ? `${ar.header.offline} · ${fill(ar.header.syncPending, { n: pending })}`
              : ar.header.offline
            : ar.header.syncError
  return (
    <Link
      to="/sync"
      aria-label={`${ar.header.syncOpen}: ${text}`}
      className="flex min-h-11 items-center rounded-full border border-white/60 px-3 text-sm"
    >
      <span aria-hidden="true">{SYNC_ICON[status]} </span>
      {text}
    </Link>
  )
}

export function Shell() {
  const { lock, sessionExpired, clockOff } = useAuth()
  const { pendingTooLong } = useSyncStatus()
  const update = useUpdate()

  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-14 items-center justify-between bg-navy px-4 text-white">
        <h1 className="font-bold">{ar.appName}</h1>
        <div className="flex items-center gap-3">
          <SyncChip />
          <button
            type="button"
            onClick={lock}
            className="min-h-11 min-w-11 rounded-xl bg-white/15 px-3"
            aria-label={ar.header.lock}
          >
            <span aria-hidden="true">🔒</span>
          </button>
        </div>
      </header>
      {!isStandalone() && <Banner>{ar.banner.install}</Banner>}
      {sessionExpired && <Banner>{ar.banner.sessionExpired}</Banner>}
      {clockOff && <Banner>{ar.banner.clockOff}</Banner>}
      {pendingTooLong && <Banner>{ar.banner.pendingOld}</Banner>}
      {update.available && (
        <div
          role="status"
          className="flex items-center gap-3 bg-accent/20 px-4 py-2 text-sm font-bold"
        >
          <span aria-hidden="true">⬆</span>
          <span className="flex-1">{ar.banner.updateAvailable}</span>
          <button
            type="button"
            onClick={update.apply}
            className="min-h-11 rounded-xl bg-navy px-4 text-white"
          >
            {ar.banner.updateNow}
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* First in the DOM = right side in RTL. */}
        <nav
          aria-label={ar.nav.menu}
          className="flex w-24 flex-col gap-1 overflow-y-auto bg-white p-2"
        >
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex min-h-16 flex-col items-center justify-center rounded-xl px-1 text-center text-sm ${
                  isActive
                    ? 'border-2 border-navy bg-navy font-bold text-white'
                    : 'border-2 border-transparent'
                }`
              }
            >
              <span aria-hidden="true" className="text-xl">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
