import { db, type DbInvoice, type DbInvoiceLine, type DbPayment } from '../db'
import { allocateDiscount, invoiceTotals, lineTotal } from './billing'
import { clearCart } from './cart'
import { takeNumber } from './counters'
import { hebronDay } from './date'
import { normalizeArabic } from './normalize'
import type {
  CancelPayload,
  CustomerPayload,
  InvoiceCreatePayload,
  MarkDeliveredPayload,
  PaymentCreatePayload,
  PaymentMethod,
  PaymentVoidPayload,
} from './sync/commands'
import { syncNow } from './sync/engine'
import { effectiveStock, pendingStock } from './sync/effectiveStock'
import { enqueue, pendingCommands } from './sync/outbox'
import { uuid7 } from './uuid7'

// Every sales write works offline: it is saved on this device at once (rows the screens read,
// marked by `change_seq` 0) and queued as a command; sending starts right away if there is a
// network but is never waited for (SPEC section 8).

export class SaleError extends Error {
  constructor(
    readonly code:
      | 'EMPTY_CART'
      | 'NO_CUSTOMER'
      | 'INSUFFICIENT_STOCK'
      | 'BAD_DISCOUNT'
      | 'BAD_PAYMENT'
      | 'CHEQUE_NOTE'
      | 'NO_REASON'
      | 'UNKNOWN_PAYMENT'
      | 'UNKNOWN_CUSTOMER'
      | 'UNKNOWN_VARIANT',
    readonly variantId?: string,
    readonly available?: number,
  ) {
    super(code)
  }
}

const clean = (text: string | null | undefined) => {
  const value = (text ?? '').replace(/\s+/g, ' ').trim()
  return value === '' ? null : value
}

export interface CustomerInput {
  id?: string
  name: string
  shopName?: string
  phone?: string
  area?: string
  address?: string
  notes?: string
  /** Agorot, positive = he already owes this much. Only used when the customer is created. */
  openingBalance?: number
  isActive?: boolean
}

/** Adds a customer or edits one. Returns his id. */
export async function saveCustomer(input: CustomerInput): Promise<string> {
  const id = input.id ?? uuid7()
  const payload: CustomerPayload = {
    customer_id: id,
    name: input.name.replace(/\s+/g, ' ').trim(),
    shop_name: clean(input.shopName),
    phone: clean(input.phone),
    area: clean(input.area),
    address: clean(input.address),
    notes: clean(input.notes),
    opening_balance: input.openingBalance ?? 0,
    is_active: input.isActive ?? true,
  }
  await db.transaction('rw', [db.customers, db.outbox], async () => {
    const existing = await db.customers.get(id)
    const search_text = normalizeArabic(
      [payload.name, payload.shop_name, payload.phone, payload.area].filter(Boolean).join(' '),
    )
    await db.customers.put({
      id,
      name: payload.name,
      shop_name: payload.shop_name,
      phone: payload.phone,
      area: payload.area,
      address: payload.address,
      notes: payload.notes,
      // The opening balance is fixed when the customer is created; editing never changes it.
      opening_balance: existing?.opening_balance ?? payload.opening_balance,
      search_text,
      is_active: payload.is_active,
      balance: existing?.balance ?? payload.opening_balance,
      change_seq: existing?.change_seq ?? 0,
    })
    await enqueue('customer.upsert', payload)
  })
  void syncNow()
  return id
}

export interface SaleInput {
  customerId: string | null
  lines: { variantId: string; qty: number }[]
  /** Fixed discount in agorot. */
  discount: number
  /** Paid now, in agorot: 0 is fine, more than the total is fine. */
  paid: number
  method: PaymentMethod
  payNote?: string
  note?: string
}

/**
 * Confirms a sale (SPEC F7): in one transaction it checks the stock on the shelf, takes the next
 * invoice (and payment) number, writes the invoice, its lines and its payment, queues the command
 * and empties the cart. Nothing here waits for the network.
 */
export async function confirmSale(
  input: SaleInput,
): Promise<{ invoiceId: string; number: string }> {
  if (input.customerId === null) throw new SaleError('NO_CUSTOMER')
  if (input.lines.length === 0) throw new SaleError('EMPTY_CART')
  if (!Number.isInteger(input.paid) || input.paid < 0) throw new SaleError('BAD_PAYMENT')
  if (input.paid > 0 && input.method === 'cheque' && !clean(input.payNote)) {
    throw new SaleError('CHEQUE_NOTE')
  }
  const customerId = input.customerId
  const issuedAt = new Date().toISOString()
  const invoiceId = uuid7()

  const number = await db.transaction(
    'rw',
    [
      db.outbox,
      db.invoices,
      db.invoice_lines,
      db.payments,
      db.carts,
      db.meta,
      db.variants,
      db.products,
    ],
    async () => {
      const variants = await db.variants.bulkGet(input.lines.map((l) => l.variantId))
      const pending = await pendingCommands()
      const rows: {
        line: (typeof input.lines)[number]
        variant: NonNullable<(typeof variants)[number]>
      }[] = []
      input.lines.forEach((line, i) => {
        const variant = variants[i]
        if (!variant) throw new SaleError('UNKNOWN_VARIANT', line.variantId)
        const available = effectiveStock(variant.id, variant.stock_qty, pending)
        if (line.qty <= 0 || line.qty > available) {
          throw new SaleError('INSUFFICIENT_STOCK', variant.id, Math.max(available, 0))
        }
        rows.push({ line, variant })
      })
      // The same variant twice must still fit on the shelf as a whole.
      const wanted = new Map<string, number>()
      for (const { line } of rows)
        wanted.set(line.variantId, (wanted.get(line.variantId) ?? 0) + line.qty)
      const shelf = pendingStock(
        new Map(rows.map((r) => [r.variant.id, r.variant.stock_qty])),
        pending,
      )
      for (const [variantId, qty] of wanted) {
        const available =
          shelf.get(variantId) ?? rows.find((r) => r.variant.id === variantId)!.variant.stock_qty
        if (qty > available)
          throw new SaleError('INSUFFICIENT_STOCK', variantId, Math.max(available, 0))
      }

      const products = await db.products.bulkGet(rows.map((r) => r.variant.product_id))
      const totals = rows.map((r) => lineTotal(r.line.qty, r.variant.price))
      let subtotal: number
      let total: number
      try {
        ;({ subtotal, total } = invoiceTotals(totals, input.discount))
      } catch {
        throw new SaleError('BAD_DISCOUNT')
      }
      const shares = allocateDiscount(totals, input.discount)

      const invoiceNumber = await takeNumber('INV')
      const paymentNumber = input.paid > 0 ? await takeNumber('REC') : null
      const payload: InvoiceCreatePayload = {
        invoice_id: invoiceId,
        number: invoiceNumber,
        customer_id: customerId,
        issued_at: issuedAt,
        discount: input.discount,
        note: clean(input.note),
        payment:
          paymentNumber === null
            ? null
            : {
                payment_id: uuid7(),
                number: paymentNumber,
                amount: input.paid,
                method: input.method,
                note: clean(input.payNote),
              },
        lines: rows.map((r) => ({
          line_id: uuid7(),
          variant_id: r.variant.id,
          qty: r.line.qty,
          unit_price: r.variant.price,
        })),
      }

      const invoice: DbInvoice = {
        id: invoiceId,
        number: invoiceNumber,
        customer_id: customerId,
        status: 'confirmed',
        subtotal,
        discount: input.discount,
        total,
        note: payload.note,
        issued_at: issuedAt,
        delivered_at: null,
        cancelled_at: null,
        cancel_reason: null,
        change_seq: 0,
      }
      const lines: DbInvoiceLine[] = rows.map((r, i) => ({
        id: payload.lines[i]!.line_id,
        invoice_id: invoiceId,
        variant_id: r.variant.id,
        product_name: products[i]?.name ?? '',
        variant_label: [r.variant.color, r.variant.size].filter(Boolean).join(' · '),
        qty: r.line.qty,
        unit_price: r.variant.price,
        line_total: totals[i]!,
        discount_share: shares[i]!,
        sort_order: i,
        change_seq: 0,
      }))
      await db.invoices.put(invoice)
      await db.invoice_lines.bulkPut(lines)
      if (payload.payment) {
        const payment: DbPayment = {
          id: payload.payment.payment_id,
          number: payload.payment.number,
          customer_id: customerId,
          invoice_id: invoiceId,
          method: payload.payment.method,
          amount: payload.payment.amount,
          paid_at: issuedAt,
          note: payload.payment.note,
          status: 'active',
          voided_at: null,
          void_reason: null,
          change_seq: 0,
        }
        await db.payments.put(payment)
      }
      await enqueue('invoice.create', payload)
      await clearCart(input.customerId)
      return invoiceNumber
    },
  )
  void syncNow()
  return { invoiceId, number }
}

export async function markDelivered(invoiceId: string): Promise<void> {
  const payload: MarkDeliveredPayload = {
    invoice_id: invoiceId,
    delivered_at: new Date().toISOString(),
  }
  await enqueue('invoice.mark_delivered', payload)
  void syncNow()
}

/** Cancels an invoice with a reason. `voidPayment` answers the question the rep is asked when the
 * invoice has a payment: give the money back, or keep it as credit on the customer's balance. */
export async function cancelInvoice(
  invoiceId: string,
  reason: string,
  voidPayment: boolean,
): Promise<void> {
  const invoice = await db.invoices.get(invoiceId)
  if (!invoice) return
  const lines = await db.invoice_lines.where('invoice_id').equals(invoiceId).toArray()
  const payments = await db.payments.where('invoice_id').equals(invoiceId).toArray()
  // A payment the rep already voided (command still waiting) is not there to give back again.
  const voidedByWaiting = new Set(
    (await pendingCommands())
      .filter((c) => c.type === 'payment.void')
      .map((c) => (c.payload as PaymentVoidPayload).payment_id),
  )
  const payload: CancelPayload = {
    invoice_id: invoiceId,
    cancelled_at: new Date().toISOString(),
    reason: reason.trim(),
    void_payment: voidPayment,
    customer_id: invoice.customer_id,
    total: invoice.total,
    payment_amount: payments
      .filter((p) => p.status === 'active' && !voidedByWaiting.has(p.id))
      .reduce((sum, p) => sum + p.amount, 0),
    lines: lines.map((l) => ({ variant_id: l.variant_id, qty: l.qty })),
  }
  await enqueue('invoice.cancel', payload)
  void syncNow()
}

export interface PaymentInput {
  customerId: string
  /** Agorot, more than zero. More than he owes is fine: it becomes credit. */
  amount: number
  method: PaymentMethod
  note?: string
  /** `yyyy-MM-dd` in Hebron time; today when left out. */
  day?: string
}

/** Records money received with no new order (SPEC F10). Saved at once, queued, never waits for the
 * network. A cheque needs its number, bank and date in the note. */
export async function recordPayment(
  input: PaymentInput,
): Promise<{ paymentId: string; number: string }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new SaleError('BAD_PAYMENT')
  if (input.method === 'cheque' && !clean(input.note)) throw new SaleError('CHEQUE_NOTE')
  const paymentId = uuid7()
  const number = await db.transaction(
    'rw',
    [db.outbox, db.payments, db.customers, db.meta],
    async () => {
      if (!(await db.customers.get(input.customerId))) throw new SaleError('UNKNOWN_CUSTOMER')
      const number = await takeNumber('REC')
      const paidAt = paidAtFor(input.day)
      const payload: PaymentCreatePayload = {
        payment_id: paymentId,
        number,
        customer_id: input.customerId,
        paid_at: paidAt,
        amount: input.amount,
        method: input.method,
        note: clean(input.note),
      }
      const payment: DbPayment = {
        id: paymentId,
        number,
        customer_id: input.customerId,
        invoice_id: null,
        method: input.method,
        amount: input.amount,
        paid_at: paidAt,
        note: payload.note,
        status: 'active',
        voided_at: null,
        void_reason: null,
        change_seq: 0,
      }
      await db.payments.put(payment)
      await enqueue('payment.create', payload)
      return number
    },
  )
  void syncNow()
  return { paymentId, number }
}

/** The moment to store for a payment dated `day`: now when it is today, else noon of that day. */
function paidAtFor(day: string | undefined): string {
  const now = new Date()
  if (!day || day === hebronDay(now.toISOString())) return now.toISOString()
  return new Date(`${day}T12:00:00+02:00`).toISOString()
}

/** Voids a payment recorded by mistake: it stays on record, marked voided, with the reason. */
export async function voidPayment(paymentId: string, reason: string): Promise<void> {
  if (!clean(reason)) throw new SaleError('NO_REASON')
  const payment = await db.payments.get(paymentId)
  if (!payment) throw new SaleError('UNKNOWN_PAYMENT')
  const payload: PaymentVoidPayload = {
    payment_id: paymentId,
    voided_at: new Date().toISOString(),
    reason: reason.trim(),
    customer_id: payment.customer_id,
    amount: payment.amount,
  }
  await enqueue('payment.void', payload)
  void syncNow()
}
