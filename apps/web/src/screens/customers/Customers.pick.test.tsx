import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wipeLocalData } from '../../db'
import { ar } from '../../i18n/ar'
import { saveCustomer } from '../../lib/sales'
import { Customers } from './Customers'

// jsdom has no layout, so the real virtualizer would show no rows; this stand-in lists every row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 100,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 100 })),
    measureElement: () => undefined,
  }),
}))

beforeEach(async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  await wipeLocalData()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Customers />
    </MemoryRouter>,
  )

describe('customers list used from the home screen', () => {
  it('normally a row opens the profile', async () => {
    const id = await saveCustomer({ name: 'أحمد' })
    renderAt('/customers')
    expect((await screen.findByRole('link', { name: /أحمد/ })).getAttribute('href')).toBe(
      `/customers/${id}`,
    )
    expect(screen.getByRole('heading', { name: ar.customers.title })).toBeTruthy()
  })

  it('with ?pick=payment the title asks who paid and a row opens the payment form', async () => {
    const id = await saveCustomer({ name: 'أحمد' })
    renderAt('/customers?pick=payment')
    expect((await screen.findByRole('link', { name: /أحمد/ })).getAttribute('href')).toBe(
      `/customers/${id}/payment`,
    )
    expect(screen.getByRole('heading', { name: ar.customers.pickForPayment })).toBeTruthy()
  })
})
