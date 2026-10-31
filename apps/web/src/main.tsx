import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import './index.css'
import { useUpdate } from './lib/update'

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh: () => useUpdate.setState({ available: true, apply: () => void updateSW(true) }),
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
