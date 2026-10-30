# M3 — Offline engine: notes

Branch `m3-offline-engine` (from `main`). **Status: built and checked on the PC (tests, WebKit browser journey including offline). Not yet tried on the real iPad.**
Done when (SPEC section 15): a stock-in entered offline appears on the server after reconnecting, and the same command sent twice applies once. Both are covered by the browser journey (`bash scripts/e2e.sh`) and by API tests.

## What exists
- **Server** (migration `0003`: `processed_commands`):
  - `GET /sync/pull?cursor=N`: changed categories, products, variants and images after `change_seq` N, with `cursor` and `has_more`. One write transaction shares one `change_seq`, so a page always ends on a whole group (the seed or an import comes as one big page; an ordinary write is a handful of rows). Deactivated rows and soft-deleted images are sent too.
  - `POST /sync/push`: up to 50 commands, each in its own transaction, in the order sent. The result of every command is stored under its id, so the same id again returns the stored result and changes nothing (also when two requests carry it at the same moment). A refused command (`INSUFFICIENT_STOCK`, `VARIANT_NOT_FOUND`, `VARIANT_INACTIVE`, `VALIDATION_ERROR`, `UNKNOWN_COMMAND`, `UNSUPPORTED_SCHEMA`, `MOVEMENT_ID_CONFLICT`) leaves nothing behind and is stored as `rejected`. `device_id` must be the session's device.
  - Command types: `stock.purchase`, `stock.damage`, `stock.adjust` (carries the counted quantity; the server works out the difference and warns with `STOCK_DIFFERS` if the device saw another number). The REST routes `/stock/in|adjust|damage` are gone.
- **Device** (Dexie version 2, a migration that keeps `meta`): working copy of categories, products, variants, images, plus the outbox. Catalog, product page (read), stock screens and the variant picker read the device; nothing waits for the network.
- **Shown stock = server quantity + commands still waiting**, in order (`lib/sync/effectiveStock.ts`). A rejected command stops counting, so its effect disappears from the screen by itself. A damage larger than what the device shows can't be confirmed.
- **Sync engine** (`lib/sync/engine.ts`): push, then pull, one run at a time; a command added during a run gets a second round at once. Triggers: app start, `online`, back to the front, every 60 s while open. Header chip (icon + text): synced / N pending / syncing / offline / problem; it opens the **sync screen** (pending commands, last success, refused commands with the reason, Discard / Retry; a retry gets a new command id). Banner after 24 h of pending commands. Logout is refused while commands wait.
- **Images**: after each pull every active product's thumb and full image is fetched into the service worker's `media` cache, at most 4 at a time, paused until the app is unlocked and while `setImagesPaused(true)` (for checkout, M4). Settings shows `cached of total` and a "re-download all" button.
- **Updates**: `registerType: 'prompt'`; the new service worker waits for a `SKIP_WAITING` message. A banner "تحديث متوفر" with an update button; otherwise it applies at the next cold start. Never mid-action.
- Online-only, as in SPEC section 8: product/variant/category edits, photos, import, movement history. After each such write the app runs a pull so the device copy follows.

## Checked on the PC
| Check | Result |
| --- | --- |
| API tests (pytest, real Postgres 16) | 179 pass (20 new for sync, stock tests moved to push) |
| ruff, ruff format, mypy (strict) | clean |
| Web tests (Vitest, fake-indexeddb) | 144 pass (effective stock, outbox, pull and push with stubbed network, engine, Dexie v1 to v2 upgrade, image queue limits, local catalog builders, catalog screen) |
| ESLint, Prettier, tsc | clean |
| Initial JS | 169.9 KB gzip (budget 250) |
| Browser journey in WebKit (`bash scripts/e2e.sh`), 12 tests, about 30 s | login + PIN, bad-row file refused, good file imports exactly, catalog + search, price edit, photo, stock-in/count/damage, **same command twice = one effect**, **offline: catalog visible, stock-in saved on the device and shown at once, sent by itself when the network returns**, offline write-off over the stock can't be confirmed, **a command the server refuses shows on the sync screen and can be discarded**, **reopened offline: PIN unlock and the catalog are there** |
| Large dataset (400 products, 2,000 variants), `bash scripts/e2e.sh seed` | first page of the catalog on screen about 0.3 s after opening it; reopening from the device about 0.3 s; all 2,805 rows end up on the device |
| API timing, same dataset, through Caddy | first pull of everything (2,805 rows in one page): 408 ms; pull with nothing new: p50 35 ms, p95 55 ms; push of 50 commands: median 580 ms, max about 1.1 s (budget 3 s) |

## Not verified
- **iPad, Home Screen app**: first sync time on the real device, reopening the catalog (< 300 ms), airplane-mode stock-in then reconnect, closing and reopening the app with commands waiting, image download progress and offline images, the update banner after a redeploy, the sync screen with a refused command.
- Headless WebKit on a PC writes browser storage about 15 ms per row, roughly a minute for the 2,805-row first sync; an iPad should be much faster, but the real number is unknown.
- Images are fetched but presentation mode (M8) is what shows them offline; offline display of product photos on the product page was not checked in the browser.
- CI on this branch (the WebKit journey is not part of CI).

## Decisions and deviations
- `stock_movements` are not pulled; movement history stays online. The device holds only `stock_qty`.
- A pull page may exceed 1,000 rows when a single write transaction wrote more (the seed, a big import). Applying a page is split into 250-row IndexedDB transactions, with the cursor moved last, so a big page never blocks the PIN or the outbox, and a page cut short is just fetched again.
- A retry of a refused command creates a new command id (the old id would return the stored refusal forever).
- Adjustments with a count equal to the system quantity are a no-op with a warning, not a refusal.
- No new dependencies in the app. `@playwright/test` (added in M2) is the only test dependency.
- Playwright tracing is off by default: it made every action seconds slower here.
