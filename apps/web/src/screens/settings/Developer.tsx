import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Icon, type IconName } from '../../components/Icon'
import { ar } from '../../i18n/ar'
import { APP_VERSION, CONTACT, COPYRIGHT_YEAR, DEVELOPER } from '../../lib/about'

// Who made the app and how to reach them. Opened by tapping the developer's name in Settings → About.
// Works offline (nothing here is fetched). A contact line that has no value yet is left out.

const row =
  'flex min-h-16 w-full items-center gap-3 px-4 py-3 text-start outline-accent focus-visible:outline-4 focus-visible:-outline-offset-4 active:bg-navy/5'

function Line({
  icon,
  title,
  value,
  href,
  action,
}: {
  icon: IconName
  title: string
  value: ReactNode
  href: string
  action: string
}) {
  return (
    <a href={href} className={row} aria-label={`${title}: ${action}`}>
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-navy/10 text-navy">
        <Icon name={icon} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm opacity-75">{title}</span>
        <bdi dir="ltr" className="block break-all text-lg font-bold leading-snug">
          {value}
        </bdi>
      </span>
      <Icon name="forward" className="size-5 shrink-0 opacity-50" />
    </a>
  )
}

/** '9725XXXXXXXX' → '+9725XXXXXXXX' for reading; wa.me wants the digits only. */
const phoneText = (digits: string) => `+${digits}`

export default function DeveloperPage() {
  const whatsapp = CONTACT.whatsapp.replace(/\D/g, '')

  return (
    <section className="mx-auto grid max-w-2xl gap-5 pb-8">
      <Link to="/settings" className="inline-flex min-h-11 w-fit items-center font-bold underline">
        → {ar.developer.back}
      </Link>

      <div className="grid gap-1 rounded-2xl bg-navy p-5 text-cream shadow-sm">
        <span className="grid size-14 place-items-center rounded-2xl bg-cream/15">
          <Icon name="code" className="size-8" />
        </span>
        <h2 className="mt-2 text-2xl font-bold">{DEVELOPER.ar}</h2>
        <p dir="ltr" className="text-start text-lg opacity-90">
          {DEVELOPER.en}
        </p>
        <p className="text-sm opacity-80">{ar.developer.role}</p>
      </div>

      <section aria-labelledby="dev-contact" className="grid content-start gap-2">
        <h3 id="dev-contact" className="px-1 text-base font-bold opacity-70">
          {ar.developer.contact}
        </h3>
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm [&>*+*]:border-t [&>*+*]:border-navy/10">
          {whatsapp && (
            <Line
              icon="chat"
              title={ar.developer.whatsapp}
              value={phoneText(whatsapp)}
              href={`https://wa.me/${whatsapp}`}
              action={ar.developer.whatsappOpen}
            />
          )}
          {CONTACT.email && (
            <Line
              icon="mail"
              title={ar.developer.email}
              value={CONTACT.email}
              href={`mailto:${CONTACT.email}`}
              action={ar.developer.emailOpen}
            />
          )}
        </div>
      </section>

      <section aria-labelledby="dev-rights" className="grid content-start gap-2">
        <h3 id="dev-rights" className="px-1 text-base font-bold opacity-70">
          {ar.developer.rightsTitle}
        </h3>
        <div className="grid gap-3 rounded-2xl bg-white p-5 shadow-sm">
          <p className="text-lg font-bold">
            © <bdi>{COPYRIGHT_YEAR}</bdi> {DEVELOPER.ar}. {ar.settings.rights}
          </p>
          <p className="leading-relaxed">{ar.developer.rightsText}</p>
          <p className="text-sm opacity-75">
            {ar.settings.appName} · {ar.settings.version} <bdi dir="ltr">{APP_VERSION}</bdi>
          </p>
        </div>
      </section>
    </section>
  )
}
