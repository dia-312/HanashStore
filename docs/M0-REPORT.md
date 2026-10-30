# M0 Spike — status and runbook

Branch: `spike/m0` (throwaway). Not pushed. **Result: all iPad checks passed (2026-10-30). Recommendation: GO for M1.**

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
| PDF (WeasyPrint in Docker, via Caddy) | 1 A4 page, 20 KB, Plex Arabic Regular + Bold embedded. Rasterized and inspected on the PC: Arabic letters join, columns RTL, amounts/SKUs/phone/`INV-000042`/`PO-2026/1029` keep their order. Render 1,004 ms cold, ~175 ms warm (budget 2 s) |
| Tunnel | official `cloudflare/cloudflared` image in Docker → HTTPS; page, manifest, `sw.js` (no-cache), media (immutable), font and PDF all return 200 from outside |

## Not recorded / caveats
- **A3 (`storage.persist()`)**: the checklist export has no A3 entry, so the value was not captured. Informational only; read it from tab A on the iPad if wanted.
- **PNG render time on the iPad** was not captured (3.3 s on the PC). The user saw it work; no number.
- **B2**: passed by the user's eye on the iPad; the meter shows 97 of 1,677 frames over 20 ms (5.8 %) and a worst frame of 26 fps. Average 60 fps. Fine for M1, but worth re-measuring on the real catalog.
- The `91087 ms since navigation start` figure is meaningless (the app had been open for a while); the real number is `59 ms mount->paint`.
- Leftover to delete by hand: `spike/.tools/` (an unsigned WeasyPrint exe that was downloaded but never run).

## iPad checklist (SPEC §11, §15)
| # | Check | Pass criterion | Result |
| --- | --- | --- | --- |
| A1 | Note written in airplane mode | still listed after force-close + relaunch | pass |
| A2 | Same after full iPad restart | still listed, app opens offline | pass |
| A3 | `storage.persist()` | recorded | not captured |
| B1 | Grid opens | < 1 s | pass — 59 ms mount to paint, 2,000 items, 4 cols |
| B2 | Fast scroll | no visible stutter | pass — avg 60 fps, min 26 fps, 97/1,677 frames > 20 ms |
| B3 | Thumbnails offline | all visible | pass |
| C1 | PDF Arabic shaping | letters join, digits/Latin in order | pass |
| C2 | PDF to WhatsApp (online) | arrives and opens | pass |
| C3 | PNG to WhatsApp (offline) | arrives, correct | pass |
| C4 | PNG vs PDF | same layout | pass |

## Runbook
1. Install Docker Desktop (needs admin, WSL2, probably a reboot).
2. `cd spike/web && npm run build`
3. `cd spike && docker compose up -d --build`, then check `http://localhost:8080/api/spike/invoice.pdf` renders (look at the Arabic).
4. Tunnel: `cloudflared tunnel --url http://localhost:8080` (cloudflared is not installed yet).
5. iPad: open the `https://*.trycloudflare.com` URL in Safari → Share → Add to Home Screen → open from the icon. Work through the **Checklist** tab; copy the export text back.
6. To re-seed: `cd spike/api && .venv/Scripts/python.exe -I seed.py ../web/public/media` (or in the container: `docker compose run --rm api python seed.py /out`).

## Go / no-go for M1
**GO.** The riskiest assumptions held on a real iPad as a Home Screen app: IndexedDB data survived force-close and a device restart, the 2,000-variant virtualized grid opens in ~60 ms and scrolls at ~60 fps, and the Arabic invoice reached WhatsApp both as a WeasyPrint PDF (online) and as an html-to-image PNG (offline), with the same layout.

Findings to carry into M1:
- Sharing: keep the two-tap "prepare, then share" flow as the primary path on iOS (a fresh tap is required for `navigator.share`).
- The quick Cloudflare tunnel drops every few hours; it is only a test aid, not a deployment target.
- Results come from the user's iPad (iOS/Safari 26.6) export; nothing was measured by me on the device.
