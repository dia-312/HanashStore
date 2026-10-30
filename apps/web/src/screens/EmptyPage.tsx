import { ar } from '../i18n/ar'

interface Props {
  title: string
  hint: string
  next: string
}

/** Placeholder for screens built in later milestones: says what will live here and what to do next. */
export function EmptyPage({ title, hint, next }: Props) {
  return (
    <section className="grid h-full place-items-center text-center">
      <div className="max-w-md">
        <h2 className="mb-2 text-2xl font-bold">{title}</h2>
        <p className="mb-6">{hint}</p>
        <p className="rounded-xl border-2 border-dashed border-navy/40 px-4 py-3">
          <span aria-hidden="true">→ </span>
          {next} — {ar.empty.soon}
        </p>
      </div>
    </section>
  )
}
