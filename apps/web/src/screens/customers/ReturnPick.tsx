import { Link, useParams } from 'react-router'
import { InvoiceRow } from '../../components/InvoiceRow'
import { ar } from '../../i18n/ar'
import { buildInvoiceDetail, buildInvoiceList, loadSalesSnapshot } from '../../lib/localSales'
import { useLive } from '../../lib/useLive'

/** A return starts from an invoice (SPEC F11): this lists the customer's invoices that still have
 * something to take back and opens the return screen for the one picked. */
export default function ReturnPick() {
  const { customerId = '' } = useParams()
  const data = useLive(async () => {
    const snapshot = await loadSalesSnapshot()
    const customer = snapshot.customers.find((c) => c.id === customerId)
    if (!customer) return null
    const invoices = buildInvoiceList(snapshot, { customerId, status: 'confirmed' }).filter(
      (item) => buildInvoiceDetail(snapshot, item.id)?.canReturn,
    )
    return { customer, invoices }
  }, [customerId])

  if (data === undefined) return <p aria-busy="true">{ar.common.loading}</p>
  if (data === null) return <p className="text-lg font-bold">{ar.customers.notFound}</p>

  return (
    <section className="grid max-w-3xl gap-4">
      <Link
        to={`/customers/${data.customer.id}`}
        className="inline-flex min-h-11 w-fit items-center font-bold underline"
      >
        ← {ar.payment.back}
      </Link>
      <h2 className="text-2xl font-bold">
        {ar.returns.title} · {data.customer.name}
      </h2>
      <p>{ar.returns.pickInvoice}</p>
      {data.invoices.length === 0 ? (
        <p role="status" className="rounded-2xl bg-white p-4 font-bold">
          <span aria-hidden="true">ⓘ </span>
          {ar.returns.noInvoicesAtAll}
        </p>
      ) : (
        <ul className="grid gap-2">
          {data.invoices.map((invoice) => (
            <li key={invoice.id}>
              <InvoiceRow
                invoice={invoice}
                showCustomer={false}
                to={`/invoices/${invoice.id}/return`}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
