import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ar } from '../../i18n/ar'
import { prepareExport } from '../../lib/exportData'
import ExportData from './ExportData'

const zip = (bytes = 3000) =>
  new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="hanash-export-2026-11-02.zip"',
    },
  })

const renderScreen = () =>
  render(
    <MemoryRouter>
      <ExportData />
    </MemoryRouter>,
  )

beforeEach(() => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // @ts-expect-error removing what a test added
  delete navigator.canShare
  // @ts-expect-error removing what a test added
  delete navigator.share
})

describe('export screen', () => {
  it('two taps: the file is made first, and only then can it be shared', async () => {
    const fetchStub = vi.fn(async () => zip())
    vi.stubGlobal('fetch', fetchStub)
    const share = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true })
    Object.defineProperty(navigator, 'share', { value: share, configurable: true })
    renderScreen()
    expect(screen.queryByRole('button', { name: ar.exportData.save })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: ar.exportData.prepare }))
    expect(await screen.findByText(/hanash-export-2026-11-02\.zip/)).toBeTruthy()
    expect(share).not.toHaveBeenCalled() // nothing is shared by the first tap
    expect(screen.getByText(/3 ك\.ب/)).toBeTruthy()
    expect(fetchStub).toHaveBeenCalledWith('/api/v1/export', { credentials: 'same-origin' })

    fireEvent.click(screen.getByRole('button', { name: ar.exportData.save }))
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1))
    const sent = (share.mock.calls[0] as unknown as [{ files: File[] }])[0]
    expect(sent.files[0]?.name).toBe('hanash-export-2026-11-02.zip')
    expect(sent.files[0]?.type).toBe('application/zip')
    expect(await screen.findByText(ar.exportData.shared)).toBeTruthy()
  })

  it('where sharing is not possible the file is opened so it can be saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => zip()),
    )
    const open = vi.fn()
    vi.stubGlobal('open', open)
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    renderScreen()
    fireEvent.click(screen.getByRole('button', { name: ar.exportData.prepare }))
    fireEvent.click(await screen.findByRole('button', { name: ar.exportData.save }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('blob:x', '_blank'))
    expect(await screen.findByText(ar.exportData.opened)).toBeTruthy()
  })

  it('closing the share sheet is not an error and says nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => zip()),
    )
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true })
    Object.defineProperty(navigator, 'share', {
      value: vi.fn(async () => {
        throw new DOMException('cancelled', 'AbortError')
      }),
      configurable: true,
    })
    renderScreen()
    fireEvent.click(screen.getByRole('button', { name: ar.exportData.prepare }))
    fireEvent.click(await screen.findByRole('button', { name: ar.exportData.save }))
    await waitFor(() => expect(navigator.share).toHaveBeenCalled())
    expect(screen.queryByText(ar.exportData.shared)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a refusal from the server (session ended) is shown, and nothing is offered to save', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"code":"UNAUTHENTICATED"}', {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    renderScreen()
    fireEvent.click(screen.getByRole('button', { name: ar.exportData.prepare }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: ar.exportData.save })).toBeNull()
  })

  it('offline: says it needs the internet and the button is off', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    renderScreen()
    expect(screen.getByText(ar.needsInternet)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: ar.exportData.prepare }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})

describe('prepareExport', () => {
  it('uses the name the server gives, and a fallback when there is none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(10), { status: 200 })),
    )
    expect((await prepareExport()).file.name).toBe('hanash-export.zip')
  })

  it('a lost connection is a NETWORK error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline')
      }),
    )
    await expect(prepareExport()).rejects.toMatchObject({ code: 'NETWORK' })
  })
})
