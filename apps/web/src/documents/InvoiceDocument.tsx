import { forwardRef } from 'react'
import '../../../../shared/documents.css'
import { LABELS, type InvoiceDoc } from '../lib/documents'

const L = LABELS.invoice

const Ltr = ({ children }: { children: React.ReactNode }) => <bdi dir="ltr">{children}</bdi>

/**
 * The invoice as a page. The markup mirrors apps/api/app/templates/invoice.html element for element
 * and both use shared/documents.css, so the PNG made on the device looks like the PDF made by the
 * server (SPEC section 11). A test compares their visible text.
 */
export const InvoiceDocument = forwardRef<HTMLDivElement, { doc: InvoiceDoc }>(
  function InvoiceDocument({ doc }, ref) {
    return (
      // The sheet wrapper only exists on this side: the PDF gets its margins from @page.
      <div
        ref={ref}
        style={{ width: '210mm', padding: '14mm', boxSizing: 'border-box', background: '#fff' }}
      >
        <div className="doc" dir="rtl" lang="ar">
          <table className="head">
            <tbody>
              <tr>
                <td className="biz">
                  {doc.business.logo_url && (
                    <img className="logo" src={doc.business.logo_url} alt="" />
                  )}
                  <div className="biz-name">{doc.business.name}</div>
                  {doc.business.phone && (
                    <div className="muted">
                      {LABELS.invoice.phone}: <Ltr>{doc.business.phone}</Ltr>
                    </div>
                  )}
                </td>
                <td className="meta">
                  <div className="title">{L.title}</div>
                  <div>
                    <Ltr>{doc.number}</Ltr>
                  </div>
                  <div>
                    {L.date}: <Ltr>{doc.issued_at}</Ltr>
                  </div>
                  {doc.cancelled && (
                    <>
                      <div className="stamp">{L.cancelled}</div>
                      {doc.cancel_reason && (
                        <div className="cancel-reason">
                          {L.cancelReason}: {doc.cancel_reason}
                        </div>
                      )}
                    </>
                  )}
                </td>
              </tr>
            </tbody>
          </table>

          <div className="cust">
            <div className="name">
              {doc.customer.name}
              {doc.customer.shop_name && ` — ${doc.customer.shop_name}`}
            </div>
            {doc.customer.phone && (
              <div className="muted">
                {L.phone}: <Ltr>{doc.customer.phone}</Ltr>
              </div>
            )}
          </div>

          <table className="lines">
            <thead>
              <tr>
                <th>{L.n}</th>
                <th>{L.product}</th>
                <th>{L.variant}</th>
                <th>{L.qty}</th>
                <th>{L.price}</th>
                <th>{L.total}</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l) => (
                <tr key={l.n}>
                  <td>{l.n}</td>
                  <td>{l.product}</td>
                  <td>{l.variant}</td>
                  <td className="num">
                    <Ltr>{l.qty}</Ltr>
                  </td>
                  <td className="num">
                    <Ltr>{l.unit_price}</Ltr>
                  </td>
                  <td className="num">
                    <Ltr>{l.line_total}</Ltr>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="totals">
            <tbody>
              <tr>
                <td>{L.subtotal}</td>
                <td>
                  <Ltr>{doc.totals.subtotal}</Ltr>
                </td>
              </tr>
              {doc.totals.discount && (
                <tr>
                  <td>{L.discount}</td>
                  <td>
                    <Ltr>{doc.totals.discount}</Ltr>
                  </td>
                </tr>
              )}
              <tr className="grand">
                <td>{L.grand}</td>
                <td>
                  <Ltr>{doc.totals.total}</Ltr>
                </td>
              </tr>
              <tr>
                <td>{L.paid}</td>
                <td>
                  <Ltr>{doc.totals.paid}</Ltr>
                </td>
              </tr>
              <tr className="remain">
                <td>{L.remaining}</td>
                <td>
                  <Ltr>{doc.totals.remaining}</Ltr>
                </td>
              </tr>
            </tbody>
          </table>

          {doc.note && (
            <div className="note">
              {L.note}: {doc.note}
            </div>
          )}
          {doc.business.footer && <div className="footer">{doc.business.footer}</div>}
        </div>
      </div>
    )
  },
)
