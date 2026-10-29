import { forwardRef } from 'react'
import sample from '../../../shared/sample-invoice.json'
import '../../../shared/invoice.css'
import { fmtMoney } from '../format'

// Markup mirrors spike/api/app/templates/invoice.html element for element; styles come from the one shared invoice.css.
export const invoiceTotals = () => {
  const subtotal = sample.lines.reduce((s, l) => s + l.qty * l.unit_price, 0)
  const total = subtotal - sample.discount
  return { subtotal, total, remaining: Math.max(total - sample.paid, 0) }
}

const Money = ({ v }: { v: number }) => <bdi dir="ltr">{fmtMoney(v)}</bdi>

export const InvoiceView = forwardRef<HTMLDivElement>(function InvoiceView(_, ref) {
  const t = invoiceTotals()
  return (
    // The sheet wrapper only exists on the web side (the PDF gets its margins from @page).
    <div ref={ref} style={{ width: '210mm', padding: '14mm', boxSizing: 'border-box', background: '#fff' }}>
      <div className="inv" dir="rtl" lang="ar">
        <table className="head">
          <tbody>
            <tr>
              <td className="biz">
                <div className="biz-name">{sample.business.name}</div>
                <div className="muted">هاتف: <bdi dir="ltr">{sample.business.phone}</bdi></div>
              </td>
              <td className="meta">
                <div className="title">فاتورة مبيعات</div>
                <div><bdi dir="ltr">{sample.number}</bdi></div>
                <div>التاريخ: <bdi dir="ltr">{sample.issued_at}</bdi></div>
              </td>
            </tr>
          </tbody>
        </table>

        <div className="cust">
          <div className="name">{sample.customer.name} — {sample.customer.shop}</div>
          <div className="muted">هاتف: <bdi dir="ltr">{sample.customer.phone}</bdi></div>
        </div>

        <table className="lines">
          <thead>
            <tr>
              <th>#</th><th>المنتج</th><th>النوع</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {sample.lines.map((l, i) => (
              <tr key={l.sku}>
                <td>{i + 1}</td>
                <td>{l.product}<div className="sku"><bdi dir="ltr">{l.sku}</bdi></div></td>
                <td>{l.variant}</td>
                <td className="num"><bdi dir="ltr">{l.qty}</bdi></td>
                <td className="num"><Money v={l.unit_price} /></td>
                <td className="num"><Money v={l.qty * l.unit_price} /></td>
              </tr>
            ))}
          </tbody>
        </table>

        <table className="totals">
          <tbody>
            <tr><td>المجموع</td><td><Money v={t.subtotal} /></td></tr>
            {sample.discount > 0 && <tr><td>الخصم</td><td><Money v={sample.discount} /></td></tr>}
            <tr className="grand"><td>الإجمالي النهائي</td><td><Money v={t.total} /></td></tr>
            <tr><td>المدفوع الآن</td><td><Money v={sample.paid} /></td></tr>
            <tr className="remain"><td>المتبقي على هذه الفاتورة</td><td><Money v={t.remaining} /></td></tr>
          </tbody>
        </table>

        <div className="note">
          ملاحظة: رقم الطلب <bdi dir="ltr">PO-2026/1029</bdi> — التسليم خلال <bdi dir="ltr">3</bdi> أيام، الدفعة المستلمة <Money v={sample.paid} /> نقداً.
        </div>
        <div className="footer">{sample.footer}</div>
      </div>
    </div>
  )
})
