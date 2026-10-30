import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmSheet } from '../components/ConfirmSheet'
import { db, type OutboxRow } from '../db'
import { ar, fill } from '../i18n/ar'
import { formatDateTime } from '../lib/date'
import { useLive } from '../lib/useLive'
import {
  commandVariantIds,
  type AdjustPayload,
  type DamagePayload,
  type PurchasePayload,
} from '../lib/sync/commands'
import { syncNow, useSync } from '../lib/sync/engine'
import { discard, retry } from '../lib/sync/outbox'
import { useSyncStatus } from '../lib/sync/useSyncStatus'

const button = 'min-h-11 rounded-xl border-2 border-navy/30 bg-white px-4 font-bold'

type Names = Map<string, string>

/** One line of plain Arabic for a command: what it is and which items it touches. */
function describe(command: OutboxRow, names: Names): string {
  const name = (id: string) => names.get(id) ?? id.slice(0, 8)
  if (command.type === 'stock.purchase') {
    const { items } = command.payload as PurchasePayload
    return items.map((i) => `${name(i.variant_id)} × ${i.qty}`).join('، ')
  }
  if (command.type === 'stock.damage') {
    const p = command.payload as DamagePayload
    return `${name(p.variant_id)} × ${p.qty}`
  }
  if (command.type === 'stock.adjust') {
    const p = command.payload as AdjustPayload
    return `${name(p.variant_id)} → ${p.counted_qty}`
  }
  return command.type
}

const typeLabel = (type: string) => (ar.sync.commands as Record<string, string>)[type] ?? type

function reasonText(command: OutboxRow): string {
  const error = command.error
  if (!error) return ''
  const template = (ar.sync.reasons as Record<string, string>)[error.code]
  if (!template) return error.message
  return fill(template, { available: String(error.details.available ?? '') })
}

function Row({
  command,
  names,
  children,
}: {
  command: OutboxRow
  names: Names
  children?: React.ReactNode
}) {
  return (
    <li className="grid gap-2 rounded-xl bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-bold">{typeLabel(command.type)}</span>
        <span className="text-sm opacity-70">
          {fill(ar.sync.madeAt, { time: formatDateTime(command.created_at) })}
        </span>
      </div>
      <p>{describe(command, names)}</p>
      {children}
    </li>
  )
}

export default function SyncScreen() {
  const { status, online, lastError } = useSyncStatus()
  const syncing = useSync((s) => s.syncing)
  const lastSyncAt = useSync((s) => s.lastSyncAt)
  const [discarding, setDiscarding] = useState<OutboxRow | null>(null)

  const data = useLive(async () => {
    const commands = await db.outbox.orderBy('seq').toArray()
    const ids = [...new Set(commands.flatMap((c) => commandVariantIds(c.type, c.payload)))]
    const variants = (await db.variants.bulkGet(ids)).filter((v) => v !== undefined)
    const products = await db.products.bulkGet([...new Set(variants.map((v) => v.product_id))])
    const productName = new Map(products.filter((p) => p !== undefined).map((p) => [p.id, p.name]))
    const names: Names = new Map(
      variants.map((v) => [
        v.id,
        [productName.get(v.product_id), v.color, v.size].filter(Boolean).join(' · '),
      ]),
    )
    return { commands, names }
  }, [])

  const pending = data?.commands.filter((c) => c.status === 'pending') ?? []
  const rejected = data?.commands.filter((c) => c.status === 'rejected') ?? []
  const names = data?.names ?? new Map()

  return (
    <section className="grid max-w-3xl gap-4">
      <Link to="/settings" className="inline-flex min-h-11 w-fit items-center font-bold underline">
        → {ar.settings.title}
      </Link>
      <h2 className="text-2xl font-bold">{ar.sync.title}</h2>

      <div className="grid gap-3 rounded-2xl bg-white p-4">
        <p>
          <span className="font-bold">{ar.sync.last}: </span>
          {lastSyncAt ? (
            <bdi>{formatDateTime(new Date(lastSyncAt).toISOString())}</bdi>
          ) : (
            ar.sync.never
          )}
        </p>
        {!online && (
          <p role="status" className="font-bold">
            <span aria-hidden="true">○ </span>
            {ar.sync.offline}
          </p>
        )}
        {online && lastError && (
          <p role="alert" className="font-bold text-red-700">
            <span aria-hidden="true">⚠ </span>
            {fill(ar.sync.failed, { code: lastError })}
          </p>
        )}
        <button
          type="button"
          disabled={!online || syncing}
          onClick={() => void syncNow()}
          className="min-h-12 w-fit rounded-xl bg-navy px-6 font-bold text-white disabled:opacity-40"
        >
          {syncing || status === 'syncing' ? ar.sync.syncing : ar.sync.now}
        </button>
      </div>

      <h3 className="text-lg font-bold">{fill(ar.sync.pendingTitle, { n: pending.length })}</h3>
      {pending.length === 0 ? (
        <p className="opacity-70">{ar.sync.nothingPending}</p>
      ) : (
        <ul className="grid gap-2">
          {pending.map((c) => (
            <Row key={c.id} command={c} names={names} />
          ))}
        </ul>
      )}

      <h3 className="text-lg font-bold">{fill(ar.sync.issuesTitle, { n: rejected.length })}</h3>
      {rejected.length === 0 ? (
        <p className="opacity-70">{ar.sync.nothingWrong}</p>
      ) : (
        <>
          <p>{ar.sync.issuesHint}</p>
          <ul className="grid gap-2">
            {rejected.map((c) => (
              <Row key={c.id} command={c} names={names}>
                <p role="alert" className="font-bold text-red-700">
                  <span aria-hidden="true">⚠ </span>
                  {reasonText(c)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={button}
                    onClick={() => void retry(c.id).then(syncNow)}
                  >
                    {ar.sync.retry}
                  </button>
                  <button type="button" className={button} onClick={() => setDiscarding(c)}>
                    {ar.sync.discard}
                  </button>
                </div>
              </Row>
            ))}
          </ul>
        </>
      )}

      {discarding && (
        <ConfirmSheet
          title={ar.sync.discard}
          message={ar.sync.discardConfirm}
          confirmLabel={ar.sync.discard}
          busy={false}
          onCancel={() => setDiscarding(null)}
          onConfirm={async () => {
            await discard(discarding.id)
            setDiscarding(null)
          }}
        />
      )}
    </section>
  )
}
