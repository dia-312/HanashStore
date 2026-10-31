import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wipeLocalData } from '../../db'
import { ar } from '../../i18n/ar'
import type { Variant } from '../../lib/catalogApi'
import { commandEffectOn } from '../../lib/sync/commands'
import { enqueue } from '../../lib/sync/outbox'
import { History } from './History'

const variant: Variant = {
  id: 'v1',
  product_id: 'p1',
  sku: 'SKU-1',
  color: null,
  size: null,
  price: 1000,
  min_stock: 1,
  stock_qty: 10,
  is_active: true,
  status: 'ok',
}

beforeEach(async () => {
  await wipeLocalData()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [], next_cursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('commandEffectOn', () => {
  it('names what a waiting command does to one variant', () => {
    const purchase = { note: null, items: [{ movement_id: 'm', variant_id: 'v1', qty: 4 }] }
    expect(commandEffectOn('stock.purchase', purchase, 'v1')).toMatchObject({ qty: 4 })
    expect(commandEffectOn('stock.purchase', purchase, 'other')).toBeNull()
    const damage = { movement_id: 'm', variant_id: 'v1', qty: 3, note: 'x' }
    expect(commandEffectOn('stock.damage', damage, 'v1')).toMatchObject({ qty: -3 })
    const count = { ...damage, counted_qty: 7, expected_qty: 10 }
    expect(commandEffectOn('stock.adjust', count, 'v1')).toMatchObject({ qty: 7, counted: true })
    expect(commandEffectOn('stock.nope', {}, 'v1')).toBeNull()
  })
})

describe('movement history', () => {
  it('lists commands still waiting on this device, marked as waiting, above the server list', async () => {
    await enqueue('stock.purchase', {
      note: null,
      items: [{ movement_id: 'm1', variant_id: 'v1', qty: 5 }],
    })
    await enqueue('stock.damage', { movement_id: 'm2', variant_id: 'v1', qty: 2, note: 'x' })
    await enqueue('stock.damage', { movement_id: 'm3', variant_id: 'other', qty: 9, note: 'x' })
    render(<History variant={variant} onClose={() => undefined} />)
    expect(await screen.findByText(ar.product.waiting)).toBeTruthy()
    expect(screen.getByText(/\+5/)).toBeTruthy()
    expect(screen.getByText(/-2/)).toBeTruthy()
    expect(screen.queryByText(/-9/)).toBeNull() // another variant's command is not shown here
  })

  it('shows no waiting section when nothing is waiting', async () => {
    render(<History variant={variant} onClose={() => undefined} />)
    expect(await screen.findByText(ar.product.noHistory)).toBeTruthy()
    expect(screen.queryByText(ar.product.waiting)).toBeNull()
  })
})
