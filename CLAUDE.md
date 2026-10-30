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
- dev: (fill in M1)
- test: (fill in M1)
- lint / format / typecheck: (fill in M1)
- migrate: (fill in M1)

## Structure
(folder map, fill in M1)

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
Next: M1 (Foundation), not started.
