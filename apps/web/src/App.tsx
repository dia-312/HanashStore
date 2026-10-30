import { Suspense, lazy, useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
import { ar } from './i18n/ar'
import { Catalog } from './screens/Catalog'
import { EmptyPage } from './screens/EmptyPage'
import { Lock } from './screens/Lock'
import { Login } from './screens/Login'
import { SetPin } from './screens/SetPin'
import { Shell } from './screens/Shell'
import { useAuth } from './store'
import { useAutoLock } from './useAutoLock'

// Everything off the sales path loads on demand (SPEC section 17): settings, product editing,
// stock screens, category management and the importer.
const Settings = lazy(() => import('./screens/Settings'))
const ProductPage = lazy(() => import('./screens/product/ProductPage'))
const Stock = lazy(() => import('./screens/stock/Stock'))
const Categories = lazy(() => import('./screens/settings/Categories'))
const ImportProducts = lazy(() => import('./screens/settings/ImportProducts'))

const pages = [
  { path: 'customers', ...ar.empty.customers },
  { path: 'invoices', ...ar.empty.invoices },
  { path: 'reports', ...ar.empty.reports },
]

const lazyPage = (page: React.ReactNode) => (
  <Suspense fallback={<p>{ar.common.loading}</p>}>{page}</Suspense>
)

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
              <Route path="catalog" element={<Catalog />} />
              <Route path="catalog/:productId" element={lazyPage(<ProductPage />)} />
              <Route path="stock" element={lazyPage(<Stock />)} />
              <Route path="settings" element={lazyPage(<Settings />)} />
              <Route path="settings/categories" element={lazyPage(<Categories />)} />
              <Route path="settings/import" element={lazyPage(<ImportProducts />)} />
              <Route path="*" element={<EmptyPage {...ar.empty.home} />} />
            </Route>
          </Routes>
        </BrowserRouter>
      )
  }
}
