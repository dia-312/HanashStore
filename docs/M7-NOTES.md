# M7 — Returns: notes

Branch `m7-returns` (from `main` after PR 7 was merged). **Status: built and checked on the PC (tests, WebKit browser journey). Not pushed, not yet tried on the real iPad.**
Done when (SPEC section 15): returning every line of a discounted invoice in several partial returns credits exactly its total. It does, on both sides, in unit tests, in property tests and in the browser journey (see below).

## What exists
- **Rule** (`billing.return_line_amount`, `billing.ts: returnLineAmount`, both tested against `shared/billing_cases.json`, key `returns`): a line is worth `line_total − discount_share`. Taking `qty` of `sold` back credits `floor(value × qty / sold)`; the return that takes the line's last unit gets what is left of the value, so all the returns of one line add up to exactly its value. Integer agorot, BigInt on the device.
- **Server**: command `return.create` (`services/returns.py`): id, `RET-` number, invoice, device time, optional reason, lines (invoice line, qty, `restock` or `damaged`). The server works out the amounts itself and ignores the device's preview numbers. `restock` writes one `return` stock movement (+qty, id derived from the return line, so a replay cannot add stock twice); `damaged` writes no movement. Both credit the customer. Refusals leave nothing behind: `INVOICE_NOT_FOUND`, `INVOICE_CANCELLED`, `LINE_NOT_ON_INVOICE`, `QTY_EXCEEDS_SOLD` (details: sold, already returned, requested), `DUPLICATE_NUMBER`, `VALIDATION_ERROR` (the same line twice, qty 0, bad disposition). A stopped customer can still return goods. An invoice with a return can no longer be cancelled (`HAS_RETURNS`, this existed as a stub since M4 and is now real).
- **Tables / sync**: migration `0005` (`returns`, `return_lines`, indexes, checks); both ride the pull (last 12 months, like invoices); the balance query, `/sync/numbers` (adds `RET`) and the statement now include returns. Statement rows: a return is a credit labelled "مرتجع", never hidden (it cannot be cancelled or voided).
- **Device**: Dexie v5 (`returns`, `return_lines`); `createReturn` (`lib/sales.ts`) checks the units left on each line (sold minus returned, waiting returns included, refused ones left out), takes the next `RET-` number, writes the rows at once (`change_seq` 0) and queues the command; the balance and the stock shown count a waiting return (credit; `restock` lines only for stock) from the outbox, like every other write. Discarding a refused return removes its rows; a duplicate number takes a fresh one on retry. `cancelInvoice` refuses an invoice with returns (`HAS_RETURNS`).
- **Screens**: invoice screen → "مرتجع جديد" (per line: quantity with the maximum, restock/damaged toggle with a symbol and a hint, the credit per line, total, balance before and after, confirmation sheet) and a returns list on the invoice; customer profile → "مرتجع جديد" (picks one of his invoices that still has something to return) and a returns list; the sync screen names the command and explains the new refusal codes; the stock history shows a waiting return (and, fixed on the way, a waiting sale or cancellation, which used to be labelled "stock count").
- **Statement on the device** includes returns; the closing equals the balance formula with returns (property tests below).

## Checked on the PC
| Check | Result |
| --- | --- |
| API tests | 343 pass, 2 skipped; 47 new in `tests/test_returns.py`: the rule on fixed cases, the shared fixture and 2,000 random partitions; restock and damaged; mixed lines with a discount; **the done-when test** (an invoice with a 777 discount returned in three parts, mixing restock and damaged, credits exactly its total, the balance and per-line sums agree); every refusal leaves no rows and no stock change; replay of the same command; pull; numbers; audit; statement rows and document label; **12 random histories** (invoices, partial returns, payments, voids, cancels in any order) where the statement closing equals the balance formula and every fully returned line was credited exactly its value |
| Web tests | 354 pass; initial JS 190.4 KB gzip (budget 250); new: `returns.sync.test.ts` (commands, stock and balance effects, refusals, discard, retry, the done-when case, statement label), `returns.screens.test.tsx` (the return screen, picker, profile), the shared return cases in `billing.test.ts`, and the offline random-history property in `statementBalance.test.ts` now includes partial returns (15 seeds) |
| WebKit journey | 18 pass, 1 skipped (as before); the first run timed out in the old M4 journey while Docker was still warming up, the rerun was clean; adds: an invoice with a discount, one unit returned offline (23.66 shown before saving, marked not sent, cancel button gone) → reconnect → the server has the return, the line and the stock back → the remaining two returned as damaged (47.34 = the exact remainder) → the returns add up to 71.00, the balance is back where it started, the damaged two did not return to the shelf, the return button disappears |
| ruff, ruff format, mypy, ESLint, Prettier, tsc | clean |

## Not done / not verified
- **Returns against invoices older than 12 months** (SPEC F11: they need internet because the device does not keep them). The device never lists those invoices, so the rep cannot start such a return yet; it needs a server endpoint that returns one invoice with its lines (`GET /invoices/{id}`, in the SPEC's API table but not built) and a screen path to it. Left out on purpose: no screen reaches it before M8 (search) and it would add an endpoint nothing else uses yet.
- `GET /returns` and `GET /payments` list endpoints (SPEC table): for the reports (M8/M9).
- A printable/shareable return receipt: not in the SPEC for the MVP.
- iPad: the return screen by touch (numeric keypad, the restock/damaged toggle), the picker from the profile.

## Decisions and deviations
- Quantity is typed (numeric keypad), not stepped, because a line can have many units; the maximum is shown next to the field.
- A return line is always one invoice line; picking the same line twice in one return is refused (use one bigger quantity).
- The device's preview numbers travel inside the command (`total`, `amount`, `variant_id`, `customer_id`) so the balance and stock show at once; the server ignores them.
- No new dependencies.
