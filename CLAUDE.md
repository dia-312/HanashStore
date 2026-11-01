# Sales Rep App

## What this is
Offline-first iPad PWA for one wholesale hookah/charcoal sales rep: catalog, stock, customers, presentation mode for customers, checkout with partial payments, invoices on WhatsApp, returns, reports.
Full requirements: docs/SPEC.md. Read the relevant section before every task. If something in a task conflicts with the SPEC, stop and ask.

## Stack
- apps/web: Vite + React SPA, TypeScript, Tailwind, React Router, vite-plugin-pwa, Dexie, MiniSearch, @tanstack/react-virtual, zod, react-hook-form, Zustand, html-to-image
- apps/api: FastAPI, SQLAlchemy 2, Alembic, Pydantic v2, WeasyPrint, openpyxl, Pillow, PostgreSQL 16
- shared/: normalize_cases.json and other fixtures used by both test suites
- Docker Compose: postgres, api, caddy (serves the built web app, proxies /api and /media, HTTPS)

## Commands
Always pass both compose files in development: `docker compose -f docker-compose.yml -f docker-compose.dev.yml ...` (the dev file publishes Postgres on 127.0.0.1:5432 for pytest; running with the base file alone recreates the container without that port).
- dev: start Postgres (`... up -d postgres`), then `npm run dev` (web on :5173, proxies /api) and, in `apps/api`, `.venv/Scripts/uvicorn app.main:app --reload --port 8000` (set `COOKIE_SECURE=false` for plain HTTP).
- full stack: `npm run build`, then `... up -d --build` (Caddy on http://localhost:8080). First user: `docker compose exec -T -e ADMIN_PASSWORD=... api python -m app.cli create-user --name "..."`.
- iPad over HTTPS: `... --profile tunnel up -d tunnel`, then `docker compose logs tunnel` for the random trycloudflare URL (it changes whenever the tunnel is recreated).
- test: `npm test` (web, Vitest) and `cd apps/api && .venv/Scripts/python -m pytest` (needs Postgres; uses its own `sales_test` database).
- lint / format / typecheck: `npm run lint`, `npm run format`, `npm run typecheck`; api: `ruff check . && ruff format --check . && mypy app tests scripts`.
- migrate: runs on container start; by hand `cd apps/api && alembic upgrade head`, new one `alembic revision -m "..."`.
- bundle size: `npm run build && npm run size` (fails over 250 KB gzip, SPEC section 17).
- large test dataset: `cd apps/api && python scripts/seed_large.py seed-data` (JSON files), then load the catalog part into the dev database: `docker compose <both files> exec -T api python -m scripts.load_seed /seed` (Git Bash on Windows: prefix with `MSYS_NO_PATHCONV=1`). Customers, invoices etc. get loaders in M4/M7.
- browser journey in WebKit (Safari's engine, iPad viewport) on a throwaway stack: `bash scripts/e2e.sh` (add `E2E_SKIP_SEED=1` to skip loading the large dataset). It covers offline stock-in, reconnect, duplicate commands and rejected commands.
- PDFs need pango/harfbuzz (in the api image and CI, not on the Windows host): run `pytest tests/test_documents.py` in the container (`docker compose <both files> exec api pytest ...`); the PDF tests skip themselves where pango is missing.
- stock cache check: `docker compose <both files> exec -T api python -m app.cli recompute-stock [--fix]`.

## Structure
- `apps/web/src`: `App.tsx` (switches on auth status), `store.ts` (Zustand auth/lock), `db.ts` (Dexie v5: working copy of the catalog, customers, invoices, payments, returns, carts, settings + outbox + meta), `lib/` (api, catalogApi for online-only writes, `localCatalog.ts` reads from Dexie, `sync/`: `engine` (push then pull, triggers), `pull`, `push`, `outbox`, `effectiveStock`, `stockCommands`, `images` (cache queue), `useLive`; `billing.ts` (money rules, shared fixtures), `sales.ts` (offline writes: customers, confirm sale, deliver, cancel), `localSales.ts` / `presentation.ts` / `localCatalog.ts` (read builders), `cart.ts`, `counters.ts` (document numbers), `perf.ts`, `settings.ts` (business details), `documents.ts` (invoice and statement models, same rules as the server), `share.ts` (PNG with html-to-image, PDF fetch, `navigator.share`), `date.ts` (Hebron time); lock rules, pin hash, money, normalize, errors, uuid7), `components/` (StatusBadge, ConfirmSheet, Thumb, Notices), `screens/` (Catalog, `customers/` (profile, form, `Payment`, `Statement`), `present/` (presentation mode, outside the shell), `checkout/`, `invoices/InvoiceView` in the main bundle; `invoices/Invoices`, `Sync`, `product/`, `stock/`, `settings/` are lazy chunks), `documents/` (`InvoiceDocument`, `StatementDocument`: the page layout the PNG is drawn from; `SharePanel`: prepare, preview, share; lazy chunk), `i18n/ar.ts`, `sw.ts` (service worker).
- `apps/api/app`: `main.py` (app, CSRF + X-Server-Time middleware, `/media` static in dev), `routers/` (auth, devices, categories, products, variants, images, sync, imports, settings, documents), `templates/` (invoice and statement HTML for the PDFs), `services/` (`sync.py` pull and idempotent push, `stock.py` all stock changes, `billing.py` money rules, `invoices.py`, `payments.py`, `returns.py`, `customers.py`, `settings.py`, `payments.py` (standalone payments and void), `documents.py` (invoice and statement models), `statement.py`, `pdf.py` (Jinja + WeasyPrint, imported lazily), `catalog.py`, `images.py`, `importer.py`), `models.py`, `schemas.py`, `changeseq.py`, `audit.py`, `normalize.py`, `money.py`, `storage.py` (media files), `pagination.py`, `deps.py` (session auth), `security.py`, `ratelimit.py`, `errors.py`, `cli.py`; `alembic/versions/` migrations; `tests/`; `scripts/` (`seed_large.py`, `load_seed.py`, `make_sample_import.py`).
- `shared/`: `normalize_cases.json`, `billing_cases.json`, `documents_cases.json` (both copies of each rule set are tested against them), `documents.css` (the one stylesheet for the PDF and the PNG), `documents_labels.json`, `documents_expected_text.json` (the visible text of the server's templates and of the React components must both equal it). `docs/`: SPEC, M0 to M7 notes, RESTORE (stub). `samples/`: sample import files. `apps/web/e2e/`: Playwright tests (`docker-compose.e2e.yml` is their throwaway stack).
- Root: `docker-compose.yml` (+ `.dev.yml`), `Caddyfile`, `.env.example`, `.github/workflows/ci.yml`.

## Speed comes first
- The screen never waits for the network: render from Dexie, sync in the background.
- Virtualize every long list. Load only what the screen shows.
- Lazy-load anything off the sales path (reports, charts, import, settings, stock screens).
- Budgets and rules: SPEC section 17. A change that breaks a budget is not done.

## Conventions
- Money: integer agorot everywhere. Never floats.
- IDs: UUIDv7 generated on the client.
- All field-work writes go through sync commands (POST /api/v1/sync/push). No direct create endpoints for invoices, returns, payments, stock or customers.
- Every write transaction takes change_seq from the sync_clock row (SELECT ... FOR UPDATE). Never hard-delete rows from synced tables.
- Business rules (totals, discount allocation, paid/remaining, returns, balance) live in one module per side with unit tests. Server recalculates; server wins.
- Financial records are append-only. Never delete; cancel or void with a reason.
- Overselling is blocked. One rep, one device: don't build multi-device or multi-user logic.
- Auth: password once per device, then a PIN. No Face ID or passkeys.
- Arabic text normalization only through normalizeArabic (TS) / normalize_arabic (Python), both tested against shared/normalize_cases.json.
- UI: RTL, Tailwind logical utilities only, all strings in ar.ts, Latin digits.
- Validate at the boundary: zod on the client, Pydantic on the server.

## Rules
- Do not add dependencies without asking.
- Never commit secrets; use .env (see .env.example).
- One milestone at a time (SPEC section 15), on its own branch, planned in plan mode and approved first.
- Run lint, typecheck and tests before saying a task is done. If you could not run something, say so.
- Flag for line-by-line review: auth, sync/push, money calculations, file uploads, anything that changes stock.
- Pending client inputs in SPEC section 16: use placeholders, never invent values.

## Current status
M0 (spike) done: all section 11 checks passed on the real iPad as a Home Screen app (offline storage survives close and restart, 2,000-variant grid opens in ~60 ms and scrolls at ~60 fps, Arabic PDF and PNG shared to WhatsApp). Details: `docs/M0-REPORT.md` on branch `spike/m0` (throwaway, kept for reference, not merged).
Carry into M1: keep "prepare, then share" (two taps) as the primary iOS share flow; the PNG path needs a warm-up render; re-measure scroll on the real catalog.
M1 (Foundation) built; checked on the real iPad over HTTPS as a Home Screen app (login, PIN setup, manual lock, wrong PIN, airplane-mode cold start to the Lock screen with offline PIN unlock, cold start to PIN screen within budget, persistent storage granted). Initial JS 149 KB gzip (budget 250). CI green on PR 1 (web, api, compose-smoke). Details: `docs/M1-NOTES.md`.
PR 1 merged.
M2 (Catalog and stock) built; tried on the real iPad by the user (all flows, importer refused the bad-row file and imported the good one), WebKit journey test 7/7 (`bash scripts/e2e.sh`), CI green on PR 2. Open: the client's real Excel file (SPEC done criterion; only `COLUMN_ALIASES` in `app/services/importer.py` should need to change). Details: `docs/M2-NOTES.md`.
PR 2 merged.
M3 (Offline engine) built; tried on the real iPad by the user (fast catalog, offline stock-in and damage, reconnect synced, over-stock damage blocked, all images on the device), WebKit journey 12/12, CI green on PR 3. Open gaps are listed in `docs/M3-NOTES.md` ("Known gaps"): fix them before or alongside M4 as the user decides.
PR 3 merged. PR 4 (M3 gap fixes) is open.
M4 (Customers, presentation mode, checkout, invoices) built; tried on the real iPad by the user (offline customer, presentation mode with pictures, partial payment, sync on reconnect; catalog opens in 42 ms, first sync 977 ms), WebKit journey with the SPEC section 13 flow. PR 5 is open. Details: `docs/M4-NOTES.md`.
M5 (WhatsApp output) built; tried on the real iPad by the user (business details on the invoice, PDF online, PNG shared in 271 ms, new invoice offline offers only the picture with the reason, statement both ways), WebKit journey 16/16, CI green on PR 6. Details: `docs/M5-NOTES.md`.
M6 (Payments and statement) built; tried on the real iPad by the user (offline payment shown at once and marked not sent, synced on reconnect, void with a reason, statement closing equals the balance), WebKit journey 17/17, CI green on PR 7. Details: `docs/M6-NOTES.md`.
PR 7 merged.
M7 (Returns) is built and checked on the PC (`docs/M7-NOTES.md`); it has not been tried on the real iPad yet. Then M8.
