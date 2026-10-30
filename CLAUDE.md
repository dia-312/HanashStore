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
- large test dataset: `cd apps/api && python scripts/seed_large.py seed-data` (JSON files, not loaded into Postgres until the tables exist).

## Structure
- `apps/web/src`: `App.tsx` (switches on auth status), `store.ts` (Zustand auth/lock), `db.ts` (Dexie), `lib/` (api, lock rules, pin hash, money, uuid7), `screens/`, `i18n/ar.ts`, `sw.ts` (service worker).
- `apps/api/app`: `main.py` (app, CSRF + X-Server-Time middleware), `routers/` (auth, devices), `models.py`, `deps.py` (session auth), `security.py`, `ratelimit.py`, `errors.py`, `cli.py`; `alembic/versions/` migrations; `tests/`; `scripts/seed_large.py`.
- `shared/`: fixtures for both test suites (empty until M4/M8). `docs/`: SPEC, M0 and M1 notes, RESTORE (stub).
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
Next: merge PR 1 (after your review), then M2 (not started).
