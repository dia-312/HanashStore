import { useState } from 'react'
import { OfflineNotice } from '../../components/Notices'
import { ar } from '../../i18n/ar'
import { useOnline } from '../../lib/online'
import { StockIn } from './StockIn'
import { StockCount, StockDamage } from './StockSingle'

type Tab = 'in' | 'count' | 'damage'

const tabs: { id: Tab; label: string }[] = [
  { id: 'in', label: ar.stock.tabIn },
  { id: 'count', label: ar.stock.tabCount },
  { id: 'damage', label: ar.stock.tabDamage },
]

export default function Stock() {
  const online = useOnline()
  const [tab, setTab] = useState<Tab>('in')
  // Bumping the round remounts the active form, so "new movement" starts from a clean screen.
  const [round, setRound] = useState(0)
  const again = () => setRound((r) => r + 1)

  return (
    <section className="grid max-w-5xl gap-4">
      <h2 className="text-2xl font-bold">{ar.stock.title}</h2>
      <div role="tablist" className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => {
              setTab(t.id)
              again()
            }}
            className={`min-h-12 rounded-full border-2 px-5 font-bold ${
              tab === t.id ? 'border-navy bg-navy text-white' : 'border-navy/30 bg-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {!online ? (
        <OfflineNotice />
      ) : (
        <div role="tabpanel">
          {tab === 'in' && <StockIn key={round} onAgain={again} />}
          {tab === 'count' && <StockCount key={round} onAgain={again} />}
          {tab === 'damage' && <StockDamage key={round} onAgain={again} />}
        </div>
      )}
    </section>
  )
}
