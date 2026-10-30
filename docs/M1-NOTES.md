# M1 — Foundation: notes

Branch `m1-foundation` (from `main`). **Status: built; checked on the PC and on the iPad. CI run still open.**
Done when (SPEC section 15): login works on the iPad over HTTPS, and CI is green.

## What exists
- Monorepo: `apps/web` (Vite, React 19, TS, Tailwind 4, React Router, Dexie, Zustand, zod, react-hook-form, vite-plugin-pwa), `apps/api` (FastAPI, SQLAlchemy 2, Alembic, Pydantic v2, argon2id, psycopg 3), `shared/`.
- Docker Compose: `postgres:16`, `api` (runs `alembic upgrade head`, then uvicorn, one worker), `caddy` (serves `apps/web/dist`, proxies `/api`, reserves `/media`). `docker-compose.dev.yml` adds the Postgres port and a Cloudflare tunnel profile.
- Database (migration `0001`): `users`, `devices`, `settings`, `sync_clock` (row `id=1` seeded), `sessions`.
- Auth API under `/api/v1`: `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`, `POST /auth/logout-all`, `PUT /auth/pin`, `PUT /auth/password`, `GET /devices`, `POST /devices/{id}/revoke`; `GET /api/health`.
  - argon2id password and PIN hashes; session token random, only its SHA-256 stored; cookie `HttpOnly; Secure; SameSite=Lax`, 30-day sliding expiry (cookie renewed with it).
  - `X-Requested-With: app` required on every POST/PUT/PATCH/DELETE (403 `CSRF_REJECTED`); `X-Server-Time` on every response; errors are `{code, message, details}`.
  - Login rate limit: 5 failures per minute per client IP, then a 15-minute lockout (429 `RATE_LIMITED`, `Retry-After`). In memory, so the API runs one worker.
  - One active device: a login from a second device answers 409 `DEVICE_REPLACE_CONFIRM`; with `confirm_replace` the old device is revoked and its next request gets 401 `DEVICE_REVOKED`.
  - The one user is created with `python -m app.cli create-user`; there is no sign-up endpoint.
- Web: Login, PIN setup, Lock screen (PIN pad), RTL shell (right-side navigation, online/offline pill, install banner outside the Home Screen app, clock-skew and session-expired banners), empty pages with a next action, Settings (lazy chunk).
  - Lock: on app open, after 5 minutes idle, after 5 minutes in the background. The PIN hash (PBKDF2-SHA256, 310,000 iterations, random salt) is stored on the device so unlock works offline. 5 wrong PINs: online asks for the full password, offline locks for 1, then 5, then 15 minutes.
  - A revoked device wipes IndexedDB and the service worker caches; an expired session wipes nothing; logout wipes.
  - `navigator.storage.persist()` is requested after login and its result shown in Settings.
- Large test dataset generator `apps/api/scripts/seed_large.py` (see below). CI workflow `.github/workflows/ci.yml`.

## Checked on the PC
| Check | Result |
| --- | --- |
| API tests (pytest, real Postgres 16) | 34 pass |
| ruff, ruff format, mypy (strict) | clean |
| Web tests (Vitest) | 22 pass |
| ESLint, Prettier, `tsc --noEmit` | clean (ESLint also bans physical Tailwind direction classes) |
| Production build, initial JS | 149.2 KB gzip, budget 250 KB (`npm run size`) |
| Compose stack on localhost:8080 | `/api/health` 200; login, cookie flags, CSRF 403 and wrong-password 401 checked with curl |
| Real browser (built-in pane) | login, PIN setup, lock on reload, wrong PIN message, right PIN unlock, RTL shell |
| Tunnel | page, `sw.js`, manifest and `/api/health` return 200 through the trycloudflare URL |
| iPad, Home Screen app, HTTPS (reported by the user) | login, PIN setup, manual lock, wrong PIN, airplane-mode cold start to the Lock screen, offline PIN unlock: all passed |
| iPad cold start to PIN screen | "good" (user's judgement, not measured in ms; budget 1.5 s) |
| iPad `storage.persist()` | granted ("مفعّل" in Settings) |
| Server side after the iPad login | one device "iPad" (not revoked), PIN hash stored, one active session |

Bugs the tests caught while building: devices were inserted after sessions (no `relationship()`, fixed with a flush); the PIN pattern `\d` accepted Arabic-Indic digits in Python (now `[0-9]`); a datetime in the 409 body was not JSON-serializable; the CLI printed a user after its session closed.

## Not verified
- **Cold start time in milliseconds** on the iPad: only a judgement of "good" was reported, not a number.
- **CI**: the workflow has not run (nothing is pushed). The `compose-smoke` job in particular is untested.
- **Service worker offline start** cannot be proven in the built-in browser (it refuses service workers); same limit as M0.
- **Playwright smoke test** from the plan is not done: it needs a browser download (about 150 MB, no Chrome installed here) that has not been approved. The same flow was exercised by hand in the built-in browser.
- Password change has an API and tests but no screen yet.

## Decisions and deviations
- Device registration happens inside `POST /auth/login` (one code path) instead of a separate `POST /devices`; `GET /devices` and `POST /devices/{id}/revoke` exist.
- `sessions` table added (not in SPEC section 6): server-side sessions are what make revoke and "log out everywhere" possible.
- Login rate limit keys on the client IP as seen by uvicorn. Caddy trusts private ranges, so the Cloudflare tunnel's forwarded IP is used; if a proxy hid the IP, every request would share one counter.
- The seed script writes JSON, not rows: the tables for catalog, customers, invoices, payments and returns don't exist until M2/M4/M7. Each of those milestones adds a loader. The script verifies invoice totals, discount bounds, SKU uniqueness and return limits itself. Full run: 400 products, 2,000 variants, 500 customers, 20,000 invoices, 15,000 payments, 1,000 returns, 400 WebP thumbnails (about 27 KB each), about 40 s.
- Dependencies added beyond SPEC section 3, all dev or support tooling: `@eslint/js`, `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks`, `prettier`, `jsdom`, `fake-indexeddb`, `@testing-library/react` (installed, not used yet); API `psycopg[binary]`, `argon2-cffi`, `pydantic-settings`, `uvicorn`, `ruff`, `mypy`, `pytest`, `httpx`. `pillow` is in SPEC section 3 and is used by the seed script.
- A throwaway local login is documented in `.env.example` for localhost only. The tunnel test installation uses a random password in the gitignored `.env`.

## Running it
See CLAUDE.md "Commands". The tunnel URL changes whenever the tunnel container is recreated, and the Home Screen app must then be reinstalled.
