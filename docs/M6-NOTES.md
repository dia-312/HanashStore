# M6 — Payments and statement: notes

Branch `m6-payments` (from `main` after PRs 4, 5, 6 were merged). **Status: built, checked on the PC (tests, WebKit browser journey) and tried on the real iPad by the user: all checks passed.**
Done when (SPEC section 15): statement totals equal the balance formula in tests. They do, on both sides (see below). The statement screen itself shipped in M5 because sharing needed it; M6 adds standalone payments and void.

## What exists
- **Server**: commands `payment.create` (money received with no order: id, `REC-` number, customer, device time, amount, method, note; a cheque needs its details in the note) and `payment.void` (reason required, the payment stays on record). Both idempotent through the usual command id; `services/payments.py`. A stopped customer can still pay. Overpaying is allowed and leaves credit. Voiding an already voided payment (for example one voided by an invoice cancellation) is a warning `ALREADY_VOIDED`, not a second refund. Refusals leave nothing behind: `CUSTOMER_NOT_FOUND`, `DUPLICATE_NUMBER`, `PAYMENT_NOT_FOUND`, `VALIDATION_ERROR`. Audit rows for both. The pull already carried payments with their status, so no migration was needed.
- **Device**: `recordPayment` and `voidPayment` (`lib/sales.ts`) write at once and queue, like every sales write. The shown balance counts a waiting payment (minus) and a waiting void (plus) from the outbox only. Waiting voids also show on the invoice screen, in the payments list and in the statement. A payment the server refused never counts anywhere and cannot be voided; discarding it removes its row; a duplicate receipt number takes a fresh one on retry. `cancelInvoice` leaves out a payment the rep already voided, so the money is never handed back twice.
- **Screens**: customer profile → "تسجيل دفعة" (amount, method, date up to today, note; balance before and after; credit warning; confirmation sheet with the numbers) and a payments list with a void button (reason required, shows "voided", "void waiting", "not sent", "refused by the server", and whether it was taken with an invoice). The sync screen now names every command (invoice, payment, customer…) and explains the refusal codes in Arabic (before, only stock commands had labels).
- **Statement**: a sale or payment the server refused is left out of the device statement (before, it distorted the opening row); a payment voided by a waiting void shows struck through.

## Checked on the PC
| Check | Result |
| --- | --- |
| API tests | 296 pass (26 new in `tests/test_payments.py`: create, credit, stopped customer, validation, duplicate number and replay, void, double void, void of a checkout payment, cancel-with-void after a manual void, statement rows with voided payments, old payment moves the opening row, and **12 random histories** (invoices, payments, voids, cancels in random order) where the statement closing equals `balance_of` equals the pulled balance and every running balance is the sum of the rows before it) |
| Web tests | 329 pass: payment screen, void flow, refused payments, double-refund guard, outbox discard and retry, and **15 random offline histories** where the balance on screen equals the formula written out again in the test, the opening row of the statement lands on the real opening balance, the closing equals the balance, and the toggle adds rows without changing the closing |
| WebKit journey | adds: offline payment from the profile → shown at once with the balance changed and marked "not sent" → reconnect → the server has one standalone payment (no invoice, 50.00) and balance 111.00 → void with a reason → the server marks it voided, balance back to 161.00 → the statement ends on 161.00 and shows the voided row only with the toggle |
| ruff, ruff format, mypy, ESLint, Prettier, tsc | clean |

## Also fixed on the way
- **The first PDF after the API container starts could take over 30 s** (it timed out in the browser journey twice, on the first run of M5 and again here). The API now renders a tiny statement in a background thread at start-up (`pdf.warm_up`), and the journey's PDF step takes under 8 s. Initial JS 188.4 KB gzip.

## Tried on the iPad (by the user, over the tunnel)
Offline payment from the profile (shown at once, marked not sent, balance lowered), sync on reconnect with Arabic command names on the sync screen, void with a reason (balance back), statement closing equal to the balance with the voided row only under the toggle. All passed.

## Not verified
- The payment date field uses the system date picker; on iOS it opens the wheel. A payment dated another day is stored at noon of that day.

## Decisions and deviations
- Voiding is allowed for any active payment, including one taken at checkout (SPEC F10 says payments are voided with a reason, never deleted). An invoice whose payment was voided simply shows more remaining.
- No new dependencies, no migration.
- The statement closing label is now "الرصيد الختامي" (a period can end in the past); found while checking M3 to M5.
- Standalone payments are not allocated to invoices (SPEC section 7).
