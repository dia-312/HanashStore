import { useDeferredValue, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { PinGate } from '../../components/PinGate'
import { Thumb } from '../../components/Thumb'
import { VirtualGrid } from '../../components/VirtualGrid'
import { db } from '../../db'
import { ar, fill } from '../../i18n/ar'
import { clampQty, getCart, setLineQty } from '../../lib/cart'
import { loadSnapshot } from '../../lib/localCatalog'
import { formatMoney } from '../../lib/money'
import { buildPresentCatalog, type PresentProduct } from '../../lib/presentation'
import { useSettings } from '../../lib/settings'
import { useLive } from '../../lib/useLive'
import { Badge, ProductDetail, Stepper } from './ProductDetail'

// Presentation mode (SPEC section 10): a customer-safe catalog the rep hands over. It shows
// products and prices only; the customer fills his own cart; only the rep, with the PIN, leaves or
// checks out. Nothing here reads a balance, an invoice, another customer or the sync state.

const ALL = 'all'
const priceText = (p: PresentProduct) =>
  p.priceMin === p.priceMax
    ? formatMoney(p.priceMin)
    : `${formatMoney(p.priceMin)} – ${formatMoney(p.priceMax)}`

export default function Present() {
  const { customerId } = useParams()
  const navigate = useNavigate()
  const customerKey = customerId ?? null
  const snapshot = useLive(loadSnapshot, [])
  const settings = useSettings()
  // Hidden unless the rep changed it in Settings, and while the setting is still being read.
  const hideOutOfStock = settings?.hide_out_of_stock_in_presentation ?? true
  const cart = useLive(async () => (await getCart(customerKey)) ?? null, [customerKey])
  const customer = useLive(
    async () => (customerKey ? ((await db.customers.get(customerKey)) ?? null) : null),
    [customerKey],
  )

  const [text, setText] = useState('')
  const q = useDeferredValue(text.trim())
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [color, setColor] = useState<string | undefined>()
  const [productId, setProductId] = useState<string | null>(null)
  const [cartOpen, setCartOpen] = useState(false)
  const [gate, setGate] = useState<'exit' | 'done' | null>(null)

  const catalog = useMemo(
    () => (snapshot ? buildPresentCatalog(snapshot, { q, color, hideOutOfStock }) : null),
    [snapshot, q, color, hideOutOfStock],
  )

  // Everything in the cart, with names and prices, read from the device (a variant that has since
  // been hidden still shows what the customer put there).
  const lines = useMemo(() => {
    if (!snapshot || !cart) return []
    const products = new Map(snapshot.products.map((p) => [p.id, p]))
    const full = buildPresentCatalog(snapshot, { hideOutOfStock: false })
    const available = new Map(
      full.products.flatMap((p) => p.variants.map((v) => [v.id, v.available] as const)),
    )
    return cart.lines.flatMap((line) => {
      const variant = snapshot.variants.find((v) => v.id === line.variant_id)
      if (!variant) return []
      return [
        {
          variantId: variant.id,
          qty: line.qty,
          price: variant.price,
          name: products.get(variant.product_id)?.name ?? '',
          label: [variant.color, variant.size].filter(Boolean).join(' · '),
          max: available.get(variant.id) ?? 0,
        },
      ]
    })
  }, [snapshot, cart])
  const count = lines.reduce((sum, l) => sum + l.qty, 0)
  const total = lines.reduce((sum, l) => sum + l.qty * l.price, 0)
  const inCart = (variantId: string) =>
    cart?.lines.find((l) => l.variant_id === variantId)?.qty ?? 0
  const change = (variantId: string, qty: number, max: number) =>
    void setLineQty(customerKey, variantId, clampQty(qty, max))

  const product = catalog?.products.find((p) => p.id === productId) ?? null
  const shown =
    catalog === null
      ? []
      : catalog.products.filter(
          (p) => categoryId === null || categoryId === ALL || p.category_id === categoryId,
        )
  const atHome = categoryId === null && q === '' && product === null
  const listView = catalog !== null && product === null && !atHome

  const goBack = () => {
    if (product) setProductId(null)
    else {
      setCategoryId(null)
      setColor(undefined)
      setText('')
    }
  }

  return (
    <div className="flex h-full flex-col bg-cream">
      <header className="flex flex-wrap items-center gap-3 bg-navy px-4 py-2 text-white">
        <button
          type="button"
          aria-label={ar.present.exit}
          onClick={() => setGate('exit')}
          className="min-h-11 min-w-11 rounded-xl bg-white/15 px-3"
        >
          <span aria-hidden="true">🔒</span>
        </button>
        <h1 className="font-bold">
          {customer ? fill(ar.present.forCustomer, { name: customer.name }) : ar.present.title}
        </h1>
        <input
          type="search"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setProductId(null)
          }}
          placeholder={ar.present.search}
          aria-label={ar.present.search}
          className="min-h-11 min-w-40 flex-1 rounded-xl border-2 border-white/30 bg-white px-4 text-navy"
        />
        <button
          type="button"
          onClick={() => setCartOpen(true)}
          className="min-h-12 rounded-xl bg-accent px-5 font-bold text-white"
        >
          <span aria-hidden="true">🛒 </span>
          {ar.present.cart}
          {count > 0 && <bdi className="ms-2 rounded-full bg-white px-2 text-navy">{count}</bdi>}
        </button>
      </header>

      <main
        className={`min-h-0 flex-1 p-4 ${listView ? 'flex flex-col overflow-hidden' : 'overflow-auto'}`}
      >
        {catalog === null ? (
          <p aria-busy="true">{ar.common.loading}</p>
        ) : product ? (
          <div className="mx-auto grid max-w-4xl gap-4">
            <button type="button" onClick={goBack} className="min-h-11 w-fit font-bold underline">
              → {ar.present.back}
            </button>
            <ProductDetail key={product.id} product={product} inCart={inCart} onChange={change} />
          </div>
        ) : atHome ? (
          <div className="mx-auto grid max-w-5xl gap-4">
            <h2 className="text-2xl font-bold">{ar.present.categories}</h2>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
              {[
                { id: ALL, name: ar.present.all, cover: catalog.categories[0]?.cover ?? null },
                ...catalog.categories,
              ].map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategoryId(c.id)}
                  className="overflow-hidden rounded-2xl bg-white text-start shadow-sm"
                >
                  <Thumb url={c.cover} eager />
                  <span className="block p-3 text-lg font-bold">{c.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-3">
            <button type="button" onClick={goBack} className="min-h-11 w-fit font-bold underline">
              → {ar.present.categories}
            </button>
            {(catalog.colors.length > 1 || color !== undefined) && (
              <div
                role="group"
                aria-label={ar.present.color}
                className="flex gap-2 overflow-x-auto"
              >
                {[undefined, ...catalog.colors].map((c) => (
                  <button
                    key={c ?? ALL}
                    type="button"
                    aria-pressed={color === c}
                    onClick={() => setColor(c)}
                    className={`min-h-12 shrink-0 rounded-full border-2 px-5 text-lg font-bold ${
                      color === c ? 'border-navy bg-navy text-white' : 'border-navy/30 bg-white'
                    }`}
                  >
                    {color === c && <span aria-hidden="true">✓ </span>}
                    {c ?? ar.present.allColors}
                  </button>
                ))}
              </div>
            )}
            {shown.length === 0 ? (
              <p className="py-10 text-center text-lg">{ar.present.noProducts}</p>
            ) : (
              <VirtualGrid
                items={shown}
                keyOf={(p) => p.id}
                render={(p) => (
                  <button
                    type="button"
                    onClick={() => setProductId(p.id)}
                    className="block w-full overflow-hidden rounded-2xl bg-white text-start shadow-sm"
                  >
                    <Thumb url={p.thumb} eager />
                    <span className="grid gap-1 p-3">
                      <span className="line-clamp-2 min-h-12 text-lg font-bold">{p.name}</span>
                      <bdi className="font-bold">{priceText(p)}</bdi>
                      <span>
                        <Badge availability={p.availability} />
                      </span>
                    </span>
                  </button>
                )}
              />
            )}
          </div>
        )}
      </main>

      {cartOpen && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-navy/50 sm:items-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={ar.present.cart}
            className="flex max-h-[90%] w-full max-w-xl flex-col rounded-t-2xl bg-cream p-5 shadow-xl sm:rounded-2xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xl font-bold">{ar.present.cart}</h2>
              <button
                type="button"
                onClick={() => setCartOpen(false)}
                className="min-h-11 rounded-xl border-2 border-navy/30 bg-white px-4 font-bold"
              >
                {ar.present.close}
              </button>
            </div>
            {lines.length === 0 ? (
              <p className="py-6 text-center">{ar.present.cartEmpty}</p>
            ) : (
              <ul className="grid min-h-0 flex-1 gap-2 overflow-auto">
                {lines.map((l) => (
                  <li key={l.variantId} className="grid gap-2 rounded-xl bg-white p-3">
                    <span className="flex justify-between gap-3">
                      <span>
                        <span className="block font-bold">{l.name}</span>
                        {l.label && <span className="block text-sm opacity-70">{l.label}</span>}
                      </span>
                      <bdi className="font-bold">{formatMoney(l.qty * l.price)}</bdi>
                    </span>
                    <span className="flex items-center justify-between gap-3">
                      <Stepper
                        value={l.qty}
                        max={l.max}
                        label={`${l.name} ${l.label}`}
                        onChange={(n) => change(l.variantId, n, l.max)}
                      />
                      <button
                        type="button"
                        onClick={() => change(l.variantId, 0, l.max)}
                        className="min-h-11 rounded-xl border-2 border-navy/30 px-4 font-bold"
                      >
                        {ar.present.remove}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex items-center justify-between text-lg font-bold">
              <span>
                {ar.present.total} · {fill(ar.present.items, { n: count })}
              </span>
              <bdi>{formatMoney(total)}</bdi>
            </div>
            <button
              type="button"
              disabled={lines.length === 0}
              onClick={() => setGate('done')}
              className="mt-3 min-h-14 rounded-xl bg-navy px-6 text-lg font-bold text-white disabled:opacity-40"
            >
              {ar.present.done}
            </button>
          </div>
        </div>
      )}

      {gate && (
        <PinGate
          title={gate === 'exit' ? ar.present.exitTitle : ar.present.done}
          onCancel={() => setGate(null)}
          onSuccess={() =>
            navigate(
              gate === 'exit'
                ? customerId
                  ? `/customers/${customerId}`
                  : '/catalog'
                : customerId
                  ? `/checkout/${customerId}`
                  : '/checkout',
              { replace: true },
            )
          }
        />
      )}
    </div>
  )
}
