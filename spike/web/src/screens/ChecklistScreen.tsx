import { db, saveResult, useLive } from '../db'

const ITEMS: Array<{ id: string; text: string }> = [
  { id: 'A1', text: 'Note written in airplane mode is still listed after force-close + relaunch' },
  { id: 'A2', text: 'Same after a full iPad restart; app opens offline from the Home Screen icon' },
  { id: 'B1', text: 'Grid opens in < 1 s (2,000 items)' },
  { id: 'B2', text: 'Fast scroll top to bottom: no visible stutter' },
  { id: 'B3', text: 'All thumbnails visible with no network (after a cold start)' },
  { id: 'C1', text: 'PDF: Arabic letters join; digits/Latin keep the right order inside RTL text' },
  { id: 'C2', text: 'PDF shared to WhatsApp (online) — arrives and opens' },
  { id: 'C3', text: 'PNG shared to WhatsApp (offline) — arrives, Arabic and layout correct' },
  { id: 'C4', text: 'PNG and PDF look the same (layout, numbers, order)' },
]

export function ChecklistScreen() {
  const results = useLive(() => db.results.toArray(), [])
  const byId = new Map(results.map((r) => [r.id, r]))
  const metrics = results.filter((r) => r.id.startsWith('metric:'))

  const exportText = JSON.stringify(
    {
      userAgent: navigator.userAgent,
      standalone: window.matchMedia('(display-mode: standalone)').matches,
      checks: ITEMS.map((i) => ({ id: i.id, status: byId.get(i.id)?.status ?? null, note: byId.get(i.id)?.note ?? '' })),
      metrics: metrics.map((m) => ({ id: m.id, note: m.note })),
    },
    null,
    2,
  )

  return (
    <div className="h-full overflow-auto p-4">
      <h1 className="mb-3 text-xl font-bold">Spike checklist (saved on this device)</h1>
      <ul className="mb-4 space-y-2">
        {ITEMS.map((i) => {
          const r = byId.get(i.id)
          return (
            <li key={i.id} className="rounded-xl bg-white p-3 shadow-sm">
              <div className="mb-2 flex items-start gap-2 text-sm">
                <b className="w-8 shrink-0">{i.id}</b>
                <span>{i.text}</span>
              </div>
              <div className="flex gap-2">
                <button
                  className={`min-h-11 flex-1 rounded-lg font-bold ${r?.status === 'pass' ? 'bg-green-700 text-white' : 'bg-black/10'}`}
                  onClick={() => saveResult(i.id, { status: 'pass' })}
                >
                  ✓ Pass
                </button>
                <button
                  className={`min-h-11 flex-1 rounded-lg font-bold ${r?.status === 'fail' ? 'bg-red-700 text-white' : 'bg-black/10'}`}
                  onClick={() => saveResult(i.id, { status: 'fail' })}
                >
                  ✗ Fail
                </button>
              </div>
              <input
                defaultValue={r?.note ?? ''}
                onBlur={(e) => saveResult(i.id, { note: e.target.value })}
                placeholder="note"
                className="mt-2 min-h-11 w-full rounded-lg border border-black/20 px-3 text-sm"
              />
            </li>
          )
        })}
      </ul>

      <h2 className="mb-1 font-bold">Measurements (automatic)</h2>
      <ul className="mb-4 rounded-xl bg-white p-3 text-sm shadow-sm">
        {metrics.length === 0 && <li className="text-slate-500">open the Grid tab first</li>}
        {metrics.map((m) => (
          <li key={m.id} dir="ltr" className="text-start"><b>{m.id.replace('metric:', '')}</b>: {m.note}</li>
        ))}
      </ul>

      <h2 className="mb-1 font-bold">Export (copy and send to me)</h2>
      <textarea readOnly dir="ltr" value={exportText} rows={12} className="w-full rounded-xl border border-black/20 bg-white p-3 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
    </div>
  )
}
