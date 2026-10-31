import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import cases from '../../../../shared/documents_cases.json'
import expectedText from '../../../../shared/documents_expected_text.json'
import { ar } from '../i18n/ar'
import type { InvoiceDoc, StatementDoc } from '../lib/documents'
import { BlankImageError, type Prepared } from '../lib/share'
import { InvoiceDocument } from './InvoiceDocument'
import SharePanel from './SharePanel'
import { StatementDocument } from './StatementDocument'

// The visible text of a rendered page: every tag becomes one space, whitespace is collapsed. The
// server's Jinja output is reduced the same way in apps/api/tests/test_documents.py and both are
// compared with the same file, so the two renderers can't drift on content, order or numbers.
function visibleText(root: HTMLElement): string {
  return root.innerHTML
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const invoices = cases.expected_invoices as unknown as Record<string, InvoiceDoc>
const statement = cases.statements[1]!.expected as unknown as StatementDoc

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('document components show the same text as the server templates', () => {
  it('an invoice', () => {
    const { container } = render(<InvoiceDocument doc={invoices['INV-000001']!} />)
    expect(visibleText(container)).toBe(expectedText.invoice)
  })

  it('a cancelled invoice, with its stamp and reason', () => {
    const { container } = render(<InvoiceDocument doc={invoices['INV-000003']!} />)
    expect(visibleText(container)).toBe(expectedText.invoice_cancelled)
  })

  it('a statement, with the cancelled and voided rows struck through', () => {
    const { container } = render(<StatementDocument doc={statement} />)
    expect(visibleText(container)).toBe(expectedText.statement)
    expect(container.querySelectorAll('tr.off')).toHaveLength(2)
    expect(container.querySelector('tr.opening')).not.toBeNull()
  })

  it('an invoice with no discount, note or footer leaves those rows out', () => {
    const plain: InvoiceDoc = {
      ...invoices['INV-000002']!,
      note: null,
      business: { ...invoices['INV-000002']!.business, footer: '', phone: '' },
    }
    const { container } = render(<InvoiceDocument doc={plain} />)
    const text = visibleText(container)
    expect(text).not.toContain(ar.invoices.discount)
    expect(container.querySelector('.note')).toBeNull()
    expect(container.querySelector('.footer')).toBeNull()
  })

  it('shows the logo when the business has one', () => {
    const doc: InvoiceDoc = {
      ...invoices['INV-000001']!,
      business: { ...invoices['INV-000001']!.business, logo_url: '/media/settings/logo-a.webp' },
    }
    const { container } = render(<InvoiceDocument doc={doc} />)
    expect(container.querySelector('img.logo')?.getAttribute('src')).toBe(
      '/media/settings/logo-a.webp',
    )
  })

  it('never carries an overall customer balance', () => {
    const { container } = render(<InvoiceDocument doc={invoices['INV-000001']!} />)
    expect(visibleText(container)).not.toContain('الرصيد')
  })
})

const png = (): Prepared => {
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'INV-000001.png', {
    type: 'image/png',
  })
  return { file, kind: 'png', url: 'blob:fake-png', ms: 12 }
}

vi.mock('../lib/share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/share')>()
  return { ...actual, renderPng: vi.fn(), shareFile: vi.fn() }
})

const share = await import('../lib/share')

describe('share panel: prepare, then share', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    vi.mocked(share.renderPng).mockReset()
    vi.mocked(share.shareFile).mockReset()
    URL.createObjectURL = vi.fn(() => 'blob:fake')
    URL.revokeObjectURL = vi.fn()
  })

  const renderPanel = (props: Partial<Parameters<typeof SharePanel>[0]> = {}) =>
    render(
      <SharePanel
        doc={{ type: 'invoice', data: invoices['INV-000001']! }}
        fileBase="INV-000001"
        pdfPath="/invoices/abc/pdf"
        pdfBlocked={ar.share.pdfNeedsServer}
        {...props}
      />,
    )

  it('online, with an invoice the server has, offers the PDF first and the picture too', () => {
    renderPanel()
    expect(screen.getByRole('button', { name: ar.share.preparePdf })).toBeTruthy()
    expect(screen.getByRole('button', { name: ar.share.preparePng })).toBeTruthy()
  })

  it('fetches the PDF named after the invoice, shows it, and sharing is a second tap', async () => {
    const fetchStub = vi.fn(async () => new Response(new Blob(['%PDF-1.7']), { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    vi.mocked(share.shareFile).mockResolvedValue('shared')
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: ar.share.preparePdf }))
    expect(await screen.findByText(/جاهز: INV-000001\.pdf/)).toBeTruthy()
    expect(String((fetchStub.mock.calls as unknown[][])[0]?.[0])).toBe('/api/v1/invoices/abc/pdf')
    expect(share.shareFile).not.toHaveBeenCalled() // preparing never opens the share sheet
    fireEvent.click(screen.getByRole('button', { name: ar.share.share }))
    await waitFor(() => expect(share.shareFile).toHaveBeenCalledTimes(1))
    expect(vi.mocked(share.shareFile).mock.calls[0]?.[0].name).toBe('INV-000001.pdf')
    expect(await screen.findByText(ar.share.shared)).toBeTruthy()
  })

  it('offline, only the picture is possible and the panel says why', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    renderPanel()
    expect(screen.queryByRole('button', { name: ar.share.preparePdf })).toBeNull()
    expect(screen.getByRole('button', { name: ar.share.preparePng })).toBeTruthy()
    expect(screen.getByText(ar.share.pdfNeedsInternet)).toBeTruthy()
  })

  it('an invoice the server does not have yet gets the picture and the reason', () => {
    renderPanel({ pdfPath: null })
    expect(screen.queryByRole('button', { name: ar.share.preparePdf })).toBeNull()
    expect(screen.getByText(ar.share.pdfNeedsServer)).toBeTruthy()
  })

  it('prepares the picture from the page on screen and previews it', async () => {
    vi.mocked(share.renderPng).mockResolvedValue(png())
    renderPanel({ pdfPath: null })
    fireEvent.click(screen.getByRole('button', { name: ar.share.preparePng }))
    expect(await screen.findByText(/جاهز: INV-000001\.png/)).toBeTruthy()
    expect(screen.getByRole('img', { name: ar.share.preview }).getAttribute('src')).toBe(
      'blob:fake-png',
    )
    const [node, name] = vi.mocked(share.renderPng).mock.calls[0]!
    expect(name).toBe('INV-000001.png')
    expect((node as HTMLElement).textContent).toContain('INV-000001') // the off-screen page
  })

  it('a blank picture is reported so the rep can try again', async () => {
    vi.mocked(share.renderPng).mockRejectedValue(new BlankImageError())
    renderPanel({ pdfPath: null })
    fireEvent.click(screen.getByRole('button', { name: ar.share.preparePng }))
    expect(await screen.findByText(ar.share.blank)).toBeTruthy()
    expect(screen.queryByRole('button', { name: ar.share.share })).toBeNull()
  })

  it('a failed PDF request says so and offers nothing to share', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 500 })),
    )
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: ar.share.preparePdf }))
    expect(await screen.findByText(ar.share.failed)).toBeTruthy()
    expect(screen.queryByRole('button', { name: ar.share.share })).toBeNull()
  })

  it('a dismissed share sheet is not an error', async () => {
    vi.mocked(share.renderPng).mockResolvedValue(png())
    vi.mocked(share.shareFile).mockResolvedValue('dismissed')
    renderPanel({ pdfPath: null })
    fireEvent.click(screen.getByRole('button', { name: ar.share.preparePng }))
    fireEvent.click(await screen.findByRole('button', { name: ar.share.share }))
    expect(await screen.findByText(ar.share.dismissed)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('warns about a long statement when only the picture is possible', () => {
    renderPanel({ doc: { type: 'statement', data: statement }, pdfPath: null, tall: true })
    expect(screen.getByText(ar.share.tall)).toBeTruthy()
  })
})
