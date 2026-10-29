import { useEffect, useState } from 'react'
import { db, useLive } from '../db'

interface Diag {
  standalone: boolean
  persisted: string
  quota: string
  swController: boolean
  online: boolean
}

const fmtTime = (ms: number) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Hebron', hour12: false })
const mb = (n?: number) => (n == null ? '?' : `${(n / 1048576).toFixed(1)} MB`)

export function PersistenceScreen() {
  const notes = useLive(() => db.notes.orderBy('createdAt').reverse().toArray(), [])
  const launches = useLive(() => db.launches.orderBy('at').reverse().limit(10).toArray(), [])
  const [text, setText] = useState('')
  const [diag, setDiag] = useState<Diag>({
    standalone: false, persisted: '…', quota: '…', swController: false, online: navigator.onLine,
  })

  useEffect(() => {
    let alive = true
    const read = async () => {
      const storage = navigator.storage
      let persisted = 'unsupported'
      let quota = '?'
      if (storage?.persisted) {
        // SPEC section 8: ask for persistent storage; the result is shown, not assumed.
        const was = await storage.persisted()
        const now = was || (storage.persist ? await storage.persist() : false)
        persisted = now ? 'granted' : 'NOT granted'
      }
      if (storage?.estimate) {
        const e = await storage.estimate()
        quota = `${mb(e.usage)} used of ${mb(e.quota)}`
      }
      if (!alive) return
      setDiag({
        standalone:
          window.matchMedia('(display-mode: standalone)').matches ||
          (navigator as unknown as { standalone?: boolean }).standalone === true,
        persisted,
        quota,
        swController: !!navigator.serviceWorker?.controller,
        online: navigator.onLine,
      })
    }
    read()
    const onNet = () => setDiag((d) => ({ ...d, online: navigator.onLine }))
    window.addEventListener('online', onNet)
    window.addEventListener('offline', onNet)
    return () => {
      alive = false
      window.removeEventListener('online', onNet)
      window.removeEventListener('offline', onNet)
    }
  }, [])

  const add = async () => {
    const t = text.trim() || `note ${new Date().toISOString()}`
    await db.notes.add({ id: crypto.randomUUID(), text: t, createdAt: Date.now() })
    setText('')
  }

  const row = (k: string, v: string, ok?: boolean) => (
    <div className="flex justify-between gap-3 border-b border-black/10 py-1.5 text-sm">
      <span className="text-slate-600">{k}</span>
      <bdi dir="ltr" className={`font-bold ${ok === undefined ? '' : ok ? 'text-green-700' : 'text-red-700'}`}>
        {ok === undefined ? '' : ok ? '✓ ' : '✗ '}
        {v}
      </bdi>
    </div>
  )

  return (
    <div className="h-full overflow-auto p-4">
      <h1 className="mb-1 text-xl font-bold">A · Offline persistence</h1>
      <p className="mb-3 text-sm text-slate-600">
        Go offline (airplane mode), add notes, force-close the app, relaunch; then restart the iPad and relaunch. Notes and the launch log must still be here.
      </p>

      <section className="mb-4 rounded-xl bg-white p-3 shadow-sm">
        {row('Running as Home Screen app', diag.standalone ? 'yes' : 'no — Safari tab', diag.standalone)}
        {row('Network', diag.online ? 'online' : 'offline')}
        {row('Service worker controls page', diag.swController ? 'yes' : 'no', diag.swController)}
        {row('storage.persist()', diag.persisted, diag.persisted === 'granted' ? true : undefined)}
        {row('Storage', diag.quota)}
        {row('Notes in IndexedDB', String(notes.length))}
      </section>

      <div className="mb-4 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="note text (optional)"
          className="min-h-11 flex-1 rounded-lg border border-black/20 bg-white px-3"
        />
        <button onClick={add} className="min-h-11 rounded-lg bg-[#F28C28] px-5 font-bold text-white">
          Add note
        </button>
      </div>

      <h2 className="mb-1 font-bold">Notes (newest first)</h2>
      <ul className="mb-4 rounded-xl bg-white p-2 shadow-sm">
        {notes.length === 0 && <li className="p-2 text-sm text-slate-500">none yet</li>}
        {notes.map((n) => (
          <li key={n.id} className="flex justify-between gap-3 border-b border-black/5 p-2 text-sm last:border-0">
            <span>{n.text}</span>
            <bdi dir="ltr" className="text-slate-500">{fmtTime(n.createdAt)}</bdi>
          </li>
        ))}
      </ul>

      <h2 className="mb-1 font-bold">Launch log (last 10)</h2>
      <ul className="rounded-xl bg-white p-2 shadow-sm">
        {launches.map((l) => (
          <li key={l.id} className="flex justify-between gap-3 border-b border-black/5 p-2 text-sm last:border-0">
            <bdi dir="ltr">{fmtTime(l.at)}</bdi>
            <span>{l.standalone ? 'Home Screen' : 'Safari tab'} · {l.online ? 'online' : 'offline'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
