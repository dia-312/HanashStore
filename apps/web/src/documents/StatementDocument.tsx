import { forwardRef } from 'react'
import '../../../../shared/documents.css'
import { LABELS, type StatementDoc } from '../lib/documents'

const L = LABELS.statement

const Ltr = ({ children }: { children: React.ReactNode }) => <bdi dir="ltr">{children}</bdi>

/** The statement as a page: mirrors apps/api/app/templates/statement.html (see InvoiceDocument). */
export const StatementDocument = forwardRef<HTMLDivElement, { doc: StatementDoc }>(
  function StatementDocument({ doc }, ref) {
    return (
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
                      {L.phone}: <Ltr>{doc.business.phone}</Ltr>
                    </div>
                  )}
                </td>
                <td className="meta">
                  <div className="title">{L.title}</div>
                  <div>
                    {L.period}: <Ltr>{doc.period.from}</Ltr> {L.to} <Ltr>{doc.period.to}</Ltr>
                  </div>
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
                <th>{L.date}</th>
                <th>{L.doc}</th>
                <th>{L.debit}</th>
                <th>{L.credit}</th>
                <th>{L.balance}</th>
              </tr>
            </thead>
            <tbody>
              {doc.rows.map((r, i) => (
                <tr key={i} className={r.css}>
                  <td>
                    <Ltr>{r.date}</Ltr>
                  </td>
                  <td>
                    {r.label}
                    {r.number && (
                      <>
                        {' '}
                        <Ltr>{r.number}</Ltr>
                      </>
                    )}
                  </td>
                  <td className="num">{r.debit && <Ltr>{r.debit}</Ltr>}</td>
                  <td className="num">{r.credit && <Ltr>{r.credit}</Ltr>}</td>
                  <td className="num">
                    <Ltr>{r.balance}</Ltr>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="totals">
            <tbody>
              <tr>
                <td>{L.totalDebit}</td>
                <td>
                  <Ltr>{doc.totals.debit}</Ltr>
                </td>
              </tr>
              <tr>
                <td>{L.totalCredit}</td>
                <td>
                  <Ltr>{doc.totals.credit}</Ltr>
                </td>
              </tr>
              <tr className="grand">
                <td>{L.closing}</td>
                <td>
                  <Ltr>{doc.totals.closing}</Ltr>
                </td>
              </tr>
            </tbody>
          </table>

          <div className="note">{L.balanceNote}</div>
          {doc.business.footer && <div className="footer">{doc.business.footer}</div>}
        </div>
      </div>
    )
  },
)
