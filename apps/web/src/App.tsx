import { Suspense, lazy, useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
import { ar } from './i18n/ar'
import { EmptyPage } from './screens/EmptyPage'
import { Lock } from './screens/Lock'
import { Login } from './screens/Login'
import { SetPin } from './screens/SetPin'
import { Shell } from './screens/Shell'
import { useAuth } from './store'
import { useAutoLock } from './useAutoLock'

// Settings is off the sales path, so it loads on demand (SPEC section 17).
const Settings = lazy(() => import('./screens/Settings'))

const pages = [
  { path: 'catalog', ...ar.empty.catalog },
  { path: 'customers', ...ar.empty.customers },
  { path: 'invoices', ...ar.empty.invoices },
  { path: 'stock', ...ar.empty.stock },
  { path: 'reports', ...ar.empty.reports },
]

export function App() {
  const status = useAuth((s) => s.status)
  const boot = useAuth((s) => s.boot)
  useAutoLock()

  useEffect(() => {
    void boot()
  }, [boot])

  switch (status) {
    case 'booting':
      return null // IndexedDB answers in a few ms; a spinner would only flash
    case 'loggedOut':
      return <Login />
    case 'needsPin':
      return <SetPin />
    case 'locked':
      return <Lock />
    case 'unlocked':
      return (
        <BrowserRouter>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<EmptyPage {...ar.empty.home} />} />
              {pages.map(({ path, ...page }) => (
                <Route key={path} path={path} element={<EmptyPage {...page} />} />
              ))}
              <Route
                path="settings"
                element={
                  <Suspense fallback={<p>{ar.common.loading}</p>}>
                    <Settings />
                  </Suspense>
                }
              />
              <Route path="*" element={<EmptyPage {...ar.empty.home} />} />
            </Route>
          </Routes>
        </BrowserRouter>
      )
  }
}
