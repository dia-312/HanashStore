import { useState } from 'react'
import { PersistenceScreen } from './screens/PersistenceScreen'
import { GridScreen } from './screens/GridScreen'
import { ShareScreen } from './screens/ShareScreen'
import { ChecklistScreen } from './screens/ChecklistScreen'

const TABS = [
  { id: 'persist', label: 'A · Persistence' },
  { id: 'grid', label: 'B · Grid' },
  { id: 'share', label: 'C · Share' },
  { id: 'check', label: 'Checklist' },
] as const
type TabId = (typeof TABS)[number]['id']

const KEY = 'spike-tab'
function loadTab(): TabId {
  try {
    const v = localStorage.getItem(KEY)
    if (TABS.some((t) => t.id === v)) return v as TabId
  } catch { /* storage can be unavailable */ }
  return 'persist'
}

export function App() {
  // The last tab is remembered so a cold start can land directly on the grid (cold start -> grid timing).
  const [tab, setTab] = useState<TabId>(loadTab)
  const go = (id: TabId) => {
    setTab(id)
    try { localStorage.setItem(KEY, id) } catch { /* ignore */ }
  }

  return (
    <div className="flex h-dvh flex-col" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <nav className="flex gap-2 bg-[#14213D] px-3 py-2 text-white">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => go(t.id)}
            className={`min-h-11 flex-1 rounded-lg px-3 text-sm font-bold ${tab === t.id ? 'bg-[#F28C28]' : 'bg-white/10'}`}
            aria-current={tab === t.id}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="min-h-0 flex-1">
        {tab === 'persist' && <PersistenceScreen />}
        {tab === 'grid' && <GridScreen />}
        {tab === 'share' && <ShareScreen />}
        {tab === 'check' && <ChecklistScreen />}
      </main>
    </div>
  )
}
