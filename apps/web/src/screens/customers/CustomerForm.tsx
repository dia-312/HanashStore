import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { db } from '../../db'
import { ar, fill } from '../../i18n/ar'
import { agorotToInput, formatMoney, parseMoney } from '../../lib/money'
import { saveCustomer } from '../../lib/sales'
import { useLive } from '../../lib/useLive'

const input = 'min-h-12 w-full rounded-xl border-2 border-navy/30 bg-white px-3'

interface Values {
  name: string
  shopName: string
  phone: string
  area: string
  address: string
  notes: string
  opening: string
}

function Form({
  id,
  initial,
  openingFixed,
}: {
  id?: string
  initial: Values
  openingFixed?: number
}) {
  const navigate = useNavigate()
  const [values, setValues] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set =
    (key: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValues((v) => ({ ...v, [key]: e.target.value }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (values.name.trim() === '') return setError(ar.customers.nameRequired)
    const opening = openingFixed === undefined ? parseMoney(values.opening || '0') : openingFixed
    if (opening === null) return setError(ar.form.badPrice)
    setBusy(true)
    setError(null)
    try {
      const saved = await saveCustomer({
        id,
        name: values.name,
        shopName: values.shopName,
        phone: values.phone,
        area: values.area,
        address: values.address,
        notes: values.notes,
        openingBalance: opening,
      })
      navigate(`/customers/${saved}`, { replace: true })
    } catch {
      setError(ar.errors.generic)
      setBusy(false)
    }
  }

  const field = (key: keyof Values, label: string, mode?: 'tel' | 'decimal') => (
    <label className="grid gap-1">
      <span className="font-bold">{label}</span>
      <input
        className={input}
        value={values[key]}
        onChange={set(key)}
        inputMode={mode}
        dir={mode ? 'ltr' : undefined}
        maxLength={key === 'name' ? 200 : 100}
      />
    </label>
  )

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-3 rounded-2xl bg-white p-4">
      {field('name', ar.customers.name)}
      {field('shopName', ar.customers.shopName)}
      <div className="grid gap-3 md:grid-cols-2">
        {field('phone', ar.customers.phone, 'tel')}
        {field('area', ar.customers.area)}
      </div>
      {field('address', ar.customers.address)}
      <label className="grid gap-1">
        <span className="font-bold">{ar.customers.notes}</span>
        <textarea
          className={`${input} min-h-24 py-2`}
          value={values.notes}
          maxLength={2000}
          onChange={set('notes')}
        />
      </label>
      {openingFixed === undefined ? (
        <>
          {field('opening', ar.customers.openingBalance, 'decimal')}
          <p className="text-sm opacity-70">{ar.customers.openingHint}</p>
        </>
      ) : (
        <p className="font-bold">
          {fill(ar.customers.openingFixed, { amount: formatMoney(openingFixed) })}
        </p>
      )}
      {error && (
        <p role="alert" className="font-bold text-red-700">
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="min-h-12 w-fit rounded-xl bg-navy px-6 font-bold text-white disabled:opacity-50"
      >
        {busy ? ar.form.saving : id ? ar.customers.save : ar.customers.create}
      </button>
    </form>
  )
}

const empty: Values = {
  name: '',
  shopName: '',
  phone: '',
  area: '',
  address: '',
  notes: '',
  opening: '',
}

export function NewCustomer() {
  return (
    <section className="grid gap-4">
      <Link to="/customers" className="inline-flex min-h-11 w-fit items-center font-bold underline">
        ← {ar.customers.back}
      </Link>
      <h2 className="text-2xl font-bold">{ar.customers.add}</h2>
      <Form initial={empty} />
    </section>
  )
}

export function EditCustomer() {
  const { customerId = '' } = useParams()
  const customer = useLive(async () => (await db.customers.get(customerId)) ?? null, [customerId])
  return (
    <section className="grid gap-4">
      <Link
        to={`/customers/${customerId}`}
        className="inline-flex min-h-11 w-fit items-center font-bold underline"
      >
        ← {ar.customers.title}
      </Link>
      <h2 className="text-2xl font-bold">{ar.customers.edit}</h2>
      {customer === undefined ? (
        <p aria-busy="true">{ar.common.loading}</p>
      ) : customer === null ? (
        <p className="font-bold">{ar.customers.notFound}</p>
      ) : (
        <Form
          id={customer.id}
          openingFixed={customer.opening_balance}
          initial={{
            name: customer.name,
            shopName: customer.shop_name ?? '',
            phone: customer.phone ?? '',
            area: customer.area ?? '',
            address: customer.address ?? '',
            notes: customer.notes ?? '',
            opening: agorotToInput(customer.opening_balance),
          }}
        />
      )}
    </section>
  )
}
