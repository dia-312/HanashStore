# M4 — Customers, presentation mode, checkout, invoices: notes

Branch `m4-sales` (from `m3-gaps`). **Status: built and checked on the PC (tests, WebKit browser journey including the SPEC section 13 flow). Not pushed, not yet tried on the real iPad.**
Done when (SPEC section 15): the Playwright flow of section 13 passes: login → add customer → fill cart in presentation mode → checkout with a partial payment offline → go online → sync → the invoice and payment exist on the server with correct totals, balance and stock. It does (`bash scripts/e2e.sh`).

## What exists
- **Server** (migration `0004`: `customers`, `invoices`, `invoice_lines`, `payments`, with the SPEC section 6 constraints):
  - Money rules in one module, `services/billing.py` (line totals, subtotal, discount allocation rounded down with the leftover agorot to the largest remainders, remaining on an invoice, balance), tested against `shared/billing_cases.json`; the device copy `lib/billing.ts` is tested against the same file.
  - Commands: `customer.upsert`, `invoice.create` (with its payment), `invoice.mark_delivered`, `invoice.cancel` (reason, `void_payment`). The server ignores any totals from the device and works them all out; the device's `unit_price` is accepted with a `PRICE_CHANGED` warning; a sale that takes stock below zero is still recorded with a `STOCK_NEGATIVE` warning (SPEC section 7); names are snapshotted on the lines; one `sale` movement per line (movement id derived from the line id); audit rows. A refused command (`DUPLICATE_NUMBER`, `INVOICE_EXISTS`, `CUSTOMER_NOT_FOUND`, `CUSTOMER_INACTIVE`, `VARIANT_INACTIVE`, `DISCOUNT_TOO_LARGE`, `INVOICE_NOT_FOUND`, `INVOICE_CANCELLED`, `VALIDATION_ERROR`) leaves nothing behind.
  - Pull now carries customers (with their `balance`, worked out per page with three aggregate queries), invoices, lines and payments for the last 12 months. Every write that moves a balance also touches the customer row, so the balance comes down again. `GET /sync/numbers` returns the highest `INV`/`REC` numbers.
- **Device** (Dexie version 3): `customers`, `invoices`, `invoice_lines`, `payments`, `carts`.
  - Every sales write is saved at once and queued: `confirmSale` checks the shelf (counting commands already waiting), takes the next numbers, writes the invoice, lines and payment (rows with `change_seq` 0, replaced by the server's at the next pull), queues the command and empties the cart, in one transaction. `saveCustomer`, `markDelivered`, `cancelInvoice` queue commands.
  - **Effective balance** (`lib/sync/effectiveBalance.ts`): the server's balance plus waiting commands, read from the outbox only, never from the optimistic rows, so nothing is counted twice; a rejected command stops counting. Effective stock also learns sales and cancellations.
  - A push result for a sale brings the server's stock and customer balance, written in the same transaction that removes the command. Discarding a rejected sale removes the optimistic rows; retrying after `DUPLICATE_NUMBER` takes a fresh number.
  - Document numbers: per-kind counters in `meta`, raised to the server's highest after every sync (replacement iPad).
- **Screens**: customers (list with search, sort by name/balance/last invoice, profile with a big balance, call and WhatsApp links, "عرض للزبون", invoices, add/edit with opening balance fixed after creation, stop/activate); **presentation mode** (`/present/:customerId?`, full screen: category tiles, product grid with badges, product page with variants and a stepper bounded by the shelf, cart sheet, search; exit and "خلصت" need the PIN through `PinGate`, which uses the same attempt counting and lockout as the lock screen); **checkout** (customer picker when the sale began without one, discount, paid now required but zero allowed, method, cheque note required, summary with the balance after, credit warning, confirmation sheet with the numbers); **invoices** (list with customer/delivery/status/date filters, view with lines, discount, paid, remaining, payments, mark delivered, cancel with a reason and the "void the payment too?" question).
- Presentation mode never shows an exact quantity, a balance, another customer, invoices, navigation or sync details (tested by looking at the page text).

## Checked on the PC
| Check | Result |
| --- | --- |
| API tests (pytest, real Postgres 16) | 240 pass (59 new: billing fixtures and properties, every command, idempotency, refusals leave nothing, cancel with and without voiding the payment, balance formula, 12-month pull window, numbers, stock cache equals the movement sum) |
| ruff, ruff format, mypy (strict) | clean |
| Web tests (Vitest, fake-indexeddb) | 260 pass (billing fixtures and properties, effective stock and balance, confirming a sale atomically offline, counters, carts, Dexie v2 to v3 upgrade, presentation catalog rules, presentation screen incl. PIN gate and "nothing private on screen", customer screens, checkout rules, invoice screens) |
| ESLint, Prettier, tsc | clean |
| Initial JS | 183.6 KB gzip (budget 250); presentation mode, checkout, customers and the invoice screen are on the sales path, so they are in the main bundle |
| WebKit journey (`bash scripts/e2e.sh`, 16 tests, about 45 s when the PC is calm) | the earlier 13 plus: offline add customer → presentation mode (badge only, no quantity) → PIN → checkout with a partial payment → invoice on screen and "waiting" → reconnect → the server has invoice 9100, payment 3000, customer balance 16100 and the stock reduced → mark delivered and cancel giving the payment back → server balance back to the opening balance and stock restored |
| API timing, 2,000-variant dataset, through Caddy | push of 50 invoices (3 lines and a payment each): median 2.2 s, worst 3.2 s on this PC (budget 3 s: close, see below); pull with nothing new p95 35 ms; first pull of 2,805 rows 461 ms |

## Not verified
- **iPad, Home Screen app**: opening the customer list and an invoice (< 300 ms), presentation mode by touch (stepper size, tiles), the PIN gate on the real keypad, checkout offline, cancel with both answers, balances after reconnect. Settings shows the screen timings measured on the device.
- **The 50-invoice push is near the 3 s budget on this PC** (Docker on Windows, every command is its own transaction with several writes). Real hosting differs; measure again in M9 and, if needed, trim round trips per command (products read once per invoice, fewer audit rows).
- Not tried: a duplicate invoice number refused by the real server from the device (covered by API and device tests only).

## Decisions and deviations
- Standalone payments, void and the statement are M6; returns M7 (the balance formula already has a place for them, `has_returns` is a stub that returns false); WhatsApp/PDF M5. The customer profile therefore has only the invoices tab.
- `customer.upsert` ignores the opening balance on an existing customer: after creation the balance moves only through invoices and payments.
- Editing and cancelling use the commands' own results; a cancel command carries device-only hints (`customer_id`, `total`, `payment_amount`, `lines`) that the server ignores, so the device can show the effect before the answer.
- WhatsApp links use `wa.me` with a default country code `970` for numbers that start with 0 (assumption until the client says how his numbers look, SPEC section 16).
- Out-of-stock items are hidden in presentation mode through a constant; the setting arrives with Settings (M9).
- The invoice list shows what is on the device (the last 12 months). Older invoices appear with returns (M7).
- `invoice_lines` has its own `change_seq` (the invoice's at creation) so devices can pull it like every other table.
- No new dependencies.
