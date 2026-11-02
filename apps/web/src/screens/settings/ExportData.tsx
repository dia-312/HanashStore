import { useState } from 'react'
import { Link } from 'react-router'
import { ErrorNotice, OfflineNotice } from '../../components/Notices'
import { ar, fill } from '../../i18n/ar'
import { describeError } from '../../lib/errors'
import { prepareExport, saveExport, type ExportFile } from '../../lib/exportData'
import { useOnline } from '../../lib/online'

// Export all the data (SPEC F13). Step one makes the file on the server; step two, a second tap,
// shares or saves it (iOS only opens the share sheet straight after a tap).

const primary = 'min-h-12 rounded-xl bg-navy px-6 font-bold text-white disabled:opacity-40'

export default function ExportData() {
  const online = useOnline()
  const [busy, setBusy] = useState(false)
  const [file, setFile] = useState<ExportFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<'shared' | 'opened' | null>(null)

  const prepare = async () => {
    setBusy(true)
    setError(null)
    setDone(null)
    setFile(null)
    try {
      setFile(await prepareExport())
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!file) return
    const result = await saveExport(file, ar.exportData.shareTitle)
    if (result !== 'cancelled') setDone(result)
  }

  return (
    <section className="grid max-w-2xl gap-4">
      <Link to="/settings" className="inline-flex min-h-11 w-fit items-center font-bold underline">
        → {ar.settings.title}
      </Link>
      <h2 className="text-2xl font-bold">{ar.exportData.title}</h2>
      <p>{ar.exportData.hint}</p>
      <ul className="list-inside list-disc">
        {ar.exportData.contents.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {!online && <OfflineNotice />}
      {error && <ErrorNotice message={error} />}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={primary}
          disabled={busy || !online}
          onClick={() => void prepare()}
        >
          {busy ? ar.exportData.preparing : ar.exportData.prepare}
        </button>
        {file && (
          <button type="button" className={primary} onClick={() => void save()}>
            {ar.exportData.save}
          </button>
        )}
      </div>
      {file && (
        <p role="status" className="font-bold">
          <span aria-hidden="true">✓ </span>
          {fill(ar.exportData.ready, { name: file.file.name, kb: file.kb })}
        </p>
      )}
      {done && (
        <p role="status">
          <span aria-hidden="true">✓ </span>
          {done === 'shared' ? ar.exportData.shared : ar.exportData.opened}
        </p>
      )}
    </section>
  )
}
