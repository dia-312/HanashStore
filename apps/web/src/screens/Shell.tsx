import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router'
import { ar } from '../i18n/ar'
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

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

function Banner({ children }: { children: string }) {
  return (
    <p role="status" className="bg-accent/20 px-4 py-2 text-sm font-bold">
      <span aria-hidden="true">ⓘ </span>
      {children}
    </p>
  )
}

export function Shell() {
  const { lock, sessionExpired, clockOff } = useAuth()
  const online = useOnline()

  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-14 items-center justify-between bg-navy px-4 text-white">
        <h1 className="font-bold">{ar.appName}</h1>
        <div className="flex items-center gap-3">
          {/* Icon + text + shape, never colour alone (CLAUDE rule on status). */}
          <span
            className="rounded-full border border-white/60 px-3 py-1 text-sm"
            title={ar.header.syncSoon}
          >
            <span aria-hidden="true">{online ? '● ' : '○ '}</span>
            {online ? ar.header.online : ar.header.offline}
          </span>
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
