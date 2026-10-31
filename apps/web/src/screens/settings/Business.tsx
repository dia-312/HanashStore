import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { ErrorNotice, OfflineNotice } from '../../components/Notices'
import { ar } from '../../i18n/ar'
import { describeError } from '../../lib/errors'
import { useOnline } from '../../lib/online'
import { saveSettings, uploadLogo, useSettings, type Business } from '../../lib/settings'

const input = 'min-h-12 w-full rounded-xl border-2 border-navy/30 bg-white px-3'

function Form({ settings }: { settings: Business }) {
  const [name, setName] = useState(settings.business_name)
  const [phone, setPhone] = useState(settings.phone)
  const [footer, setFooter] = useState(settings.invoice_footer)
  const [hideOut, setHideOut] = useState(settings.hide_out_of_stock_in_presentation)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await action()
      setSaved(true)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void run(() =>
      saveSettings({
        business_name: name.trim(),
        phone: phone.trim(),
        invoice_footer: footer.trim(),
        hide_out_of_stock_in_presentation: hideOut,
      }),
    )
  }

  return (
    <form onSubmit={submit} className="grid max-w-xl gap-3 rounded-2xl bg-white p-4">
      <label className="grid gap-1">
        <span className="font-bold">{ar.business.name}</span>
        <input
          className={input}
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="grid gap-1">
        <span className="font-bold">{ar.business.phone}</span>
        <input
          className={input}
          inputMode="tel"
          dir="ltr"
          value={phone}
          maxLength={200}
          onChange={(e) => setPhone(e.target.value)}
        />
      </label>
      <label className="grid gap-1">
        <span className="font-bold">{ar.business.footer}</span>
        <textarea
          className={`${input} min-h-20 py-2`}
          value={footer}
          maxLength={500}
          onChange={(e) => setFooter(e.target.value)}
        />
      </label>

      <div className="grid gap-2">
        <span className="font-bold">{ar.business.logo}</span>
        {settings.logo_url ? (
          <img src={settings.logo_url} alt="" className="max-h-16 max-w-40 rounded bg-white" />
        ) : (
          <p className="text-sm opacity-70">{ar.business.noLogo}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex min-h-12 cursor-pointer items-center rounded-xl border-2 border-navy/30 bg-white px-5 font-bold">
            {ar.business.chooseLogo}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void run(() => uploadLogo(file))
              }}
            />
          </label>
          {settings.logo_url && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => saveSettings({ logo_url: null }))}
              className="min-h-12 rounded-xl border-2 border-navy/30 bg-white px-5 font-bold"
            >
              {ar.business.removeLogo}
            </button>
          )}
        </div>
      </div>

      <label className="flex min-h-12 items-center gap-3">
        <input
          type="checkbox"
          checked={hideOut}
          onChange={(e) => setHideOut(e.target.checked)}
          className="size-6"
        />
        <span className="font-bold">{ar.business.hideOut}</span>
      </label>

      {error && <ErrorNotice message={error} />}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="min-h-12 rounded-xl bg-navy px-6 font-bold text-white disabled:opacity-50"
        >
          {busy ? ar.form.saving : ar.form.save}
        </button>
        {saved && (
          <span role="status" className="font-bold">
            <span aria-hidden="true">✓ </span>
            {ar.form.saved}
          </span>
        )}
      </div>
    </form>
  )
}

export default function BusinessSettings() {
  const online = useOnline()
  const settings = useSettings()
  return (
    <section className="grid gap-4">
      <Link to="/settings" className="inline-flex min-h-11 w-fit items-center font-bold underline">
        → {ar.settings.title}
      </Link>
      <h2 className="text-2xl font-bold">{ar.business.title}</h2>
      <p className="max-w-xl text-sm opacity-80">{ar.business.hint}</p>
      {!online && <OfflineNotice />}
      {settings === undefined ? (
        <p aria-busy="true">{ar.common.loading}</p>
      ) : (
        <Form settings={settings} />
      )}
    </section>
  )
}
