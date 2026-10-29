# M0 Spike — status and runbook

Branch: `spike/m0` (throwaway). Not pushed. **Result so far: NOT DONE** — the iPad checks and the PDF render are still open.

## What exists
`spike/web` (Vite + React PWA: A persistence, B grid, C share, Checklist), `spike/api` (FastAPI + WeasyPrint + seed script), `spike/shared` (one `invoice.css` and one `sample-invoice.json` used by both the React component and the Jinja template), `spike/docker-compose.yml` + `Caddyfile`.

## Verified on the PC (not the iPad)
| Item | Result |
| --- | --- |
| Typecheck and production build | pass; main JS 123 KB gzip (budget 250 KB, SPEC §17); 12 files precached |
| Seed | 2,000 variants, 400 thumbnails, avg 26.1 KB WebP (SPEC target ≈ 25 KB) |
| Grid logic | 2,000 rows load from IndexedDB, only ~20 cells in the DOM, all 400 thumbnails cached; open = 86 ms on the PC |
| PNG render (html-to-image) | 1588×1556 px, 227 KB, Arabic RTL layout and numbers correct, 3.3 s on the PC including a warm-up call |
| Invoice arithmetic | ₪ 1,253.00 − 50.00 = 1,203.00; paid 200.00; remaining 1,003.00 |

## NOT verified yet
- **Service worker / offline cold start.** The in-app browser pane refuses service workers (even a one-line test worker failed), so this cannot be proven here. Needs real Chrome or the iPad.
- **PDF (WeasyPrint).** Not rendered yet. Docker Desktop is not installed on this PC, and pip WeasyPrint needs GTK on Windows. I downloaded the official standalone WeasyPrint v70.0 Windows build to `spike/.tools/` (git-ignored) but the sandbox blocked running it; it has not been run and should be deleted.
- **Scroll smoothness.** The PC pane throttles animation frames (a bare loop measured 1 fps), so its numbers mean nothing. Only the iPad counts.
- Every item in the iPad table below.

## iPad checklist (SPEC §11, §15)
| # | Check | Pass criterion | Result |
| --- | --- | --- | --- |
| A1 | Note written in airplane mode | still listed after force-close + relaunch | |
| A2 | Same after full iPad restart | still listed, app opens offline | |
| A3 | `storage.persist()` | recorded | |
| B1 | Grid opens | < 1 s | |
| B2 | Fast scroll | no visible stutter | |
| B3 | Thumbnails offline | all visible | |
| C1 | PDF Arabic shaping | letters join, digits/Latin in order | |
| C2 | PDF to WhatsApp (online) | arrives and opens | |
| C3 | PNG to WhatsApp (offline) | arrives, correct | |
| C4 | PNG vs PDF | same layout | |

## Runbook
1. Install Docker Desktop (needs admin, WSL2, probably a reboot).
2. `cd spike/web && npm run build`
3. `cd spike && docker compose up -d --build`, then check `http://localhost:8080/api/spike/invoice.pdf` renders (look at the Arabic).
4. Tunnel: `cloudflared tunnel --url http://localhost:8080` (cloudflared is not installed yet).
5. iPad: open the `https://*.trycloudflare.com` URL in Safari → Share → Add to Home Screen → open from the icon. Work through the **Checklist** tab; copy the export text back.
6. To re-seed: `cd spike/api && .venv/Scripts/python.exe -I seed.py ../web/public/media` (or in the container: `docker compose run --rm api python seed.py /out`).

## Go / no-go for M1
Pending the iPad results.
