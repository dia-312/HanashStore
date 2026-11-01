import { Suspense, lazy, useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
import { ar } from './i18n/ar'
import { startSyncLoop } from './lib/sync/engine'
import { resumeImageDownloads, setImagesPaused } from './lib/sync/images'
import { Catalog } from './screens/Catalog'
import Checkout from './screens/checkout/Checkout'
import { CustomerProfile } from './screens/customers/CustomerProfile'
import { EditCustomer, NewCustomer } from './screens/customers/CustomerForm'
import { Customers } from './screens/customers/Customers'
import InvoiceView from './screens/invoices/InvoiceView'
import Present from './screens/present/Present'
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
const SyncScreen = lazy(() => import('./screens/Sync'))
const Statement = lazy(() => import('./screens/customers/Statement'))
const Payment = lazy(() => import('./screens/customers/Payment'))
const Refund = lazy(() => import('./screens/customers/Refund'))
const ReturnPick = lazy(() => import('./screens/customers/ReturnPick'))
const Return = lazy(() => import('./screens/invoices/Return'))
const BusinessSettings = lazy(() => import('./screens/settings/Business'))
const Invoices = lazy(() => import('./screens/invoices/Invoices'))

const pages = [{ path: 'reports', ...ar.empty.reports }]

const lazyPage = (page: React.ReactNode) => (
  <Suspense fallback={<p>{ar.common.loading}</p>}>{page}</Suspense>
)

export function App() {
  const status = useAuth((s) => s.status)
  const boot = useAuth((s) => s.boot)
  const signedIn = useAuth((s) => s.identity !== null)
  useAutoLock()

  // Sync runs whenever this device is signed in, also behind the lock screen.
  useEffect(() => (signedIn ? startSyncLoop() : undefined), [signedIn])

  // Product images download only once the app is open for use: on the very first start they would
  // otherwise compete with the login and PIN screens for the network and the processor.
  useEffect(() => {
    setImagesPaused(status !== 'unlocked')
    if (status === 'unlocked') void resumeImageDownloads()
  }, [status])

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
            {/* Presentation mode is full screen: no navigation, nothing of the rep's app. */}
            <Route path="present/:customerId?" element={<Present />} />
            <Route element={<Shell />}>
              <Route index element={<EmptyPage {...ar.empty.home} />} />
              {pages.map(({ path, ...page }) => (
                <Route key={path} path={path} element={<EmptyPage {...page} />} />
              ))}
              <Route path="catalog" element={<Catalog />} />
              <Route path="customers" element={<Customers />} />
              <Route path="customers/new" element={<NewCustomer />} />
              <Route path="customers/:customerId" element={<CustomerProfile />} />
              <Route path="customers/:customerId/statement" element={lazyPage(<Statement />)} />
              <Route path="customers/:customerId/payment" element={lazyPage(<Payment />)} />
              <Route path="customers/:customerId/refund" element={lazyPage(<Refund />)} />
              <Route path="customers/:customerId/return" element={lazyPage(<ReturnPick />)} />
              <Route path="customers/:customerId/edit" element={<EditCustomer />} />
              <Route path="checkout/:customerId?" element={<Checkout />} />
              <Route path="invoices" element={lazyPage(<Invoices />)} />
              <Route path="invoices/:invoiceId" element={<InvoiceView />} />
              <Route path="invoices/:invoiceId/return" element={lazyPage(<Return />)} />
              <Route path="catalog/:productId" element={lazyPage(<ProductPage />)} />
              <Route path="stock" element={lazyPage(<Stock />)} />
              <Route path="sync" element={lazyPage(<SyncScreen />)} />
              <Route path="settings" element={lazyPage(<Settings />)} />
              <Route path="settings/business" element={lazyPage(<BusinessSettings />)} />
              <Route path="settings/categories" element={lazyPage(<Categories />)} />
              <Route path="settings/import" element={lazyPage(<ImportProducts />)} />
              <Route path="*" element={<EmptyPage {...ar.empty.home} />} />
            </Route>
          </Routes>
        </BrowserRouter>
      )
  }
}
