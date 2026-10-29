import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import { App } from './App'
import { db } from './db'

registerSW({ immediate: true })

const standalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true

// Launch log: proves across closes/restarts that the same IndexedDB is reopened.
db.launches.add({ at: Date.now(), standalone, online: navigator.onLine }).catch(console.error)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
