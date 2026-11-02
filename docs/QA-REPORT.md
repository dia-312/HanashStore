# QA audit of M0–M8

Branch `qa-audit` (from `main` after PR 10). Date 2026-11-02. Goal: find what is wrong, or will go wrong, before real data goes in (M9).
Method: attack the code instead of reading it. Everything below that is a test stays in the repository as a regression test.

## In one paragraph
The money, stock, sync and search rules held up under heavy random testing: no invariant was ever broken. What failed was the **edges**: text and numbers a normal person does not type but a file, a paste or a bug can produce, and the walls around the app (proxy headers, the importer's view of a real spreadsheet). Nine problems were found and fixed (list below), none of which had lost or corrupted money. Eight risks remain that need a decision or work that is not code; the most important is that **there are no backups yet (M9)**, so nothing real should be entered before that exists.

## What was run
| Area | What | Result |
| --- | --- | --- |
| Existing suites | API (pytest), web (Vitest), WebKit journey, CI | all green before starting |
| Dependency audit | `npm audit --omit=dev`, `pip-audit` | 0 vulnerabilities in app dependencies (only `pip` itself, a tool, in the venv) |
| Static security | ruff with bandit rules (`S`), secret scan of tracked files, `.env` hygiene | nothing real: one false positive (table names in a raw `SELECT` are constants), no secret in git |
| Auth sweep | every route without a session / without the CSRF header / with garbage cookies | every route answers 401 (login and health excepted); every write without `X-Requested-With` is 403 |
| HTML injection | scripts, `<img src=file://…>`, internal URLs, `{{ 7*7 }}`, bidi marks in every name field, rendered in the invoice document | escaped everywhere, never evaluated |
| **Fuzz: commands** | 2,700 commands, every leaf of every payload of all 11 command types replaced by 26 nasty values (0, -1, 2^63, 10^30, 1.5, NUL, 20,000 characters, wrong types, odd dates…), then every read endpoint | found problem 1 below; afterwards no 500 and no read broken by anything that was accepted |
| **Fuzz: REST** | every field of every write endpoint (categories, products, variants, settings, synonyms) × 26 values; every query parameter of every list × 18 values | found problems 2 and 3 below |
| **State machine** | 8 seeds × 70 random operations over all command types, reused numbers, replays; after each step a refused command leaves the books byte-identical; at the end: stock cache = Σ movements, invoice lines add up, discount shares exact, returns never exceed a line, balance = the formula written out again, statement closing = balance, incremental pull = full pull, resending everything changes nothing | no invariant broken |
| Search | the 8 required cases, plus 6 seeds × 250 random queries (prefixes of words in random spellings, synonyms, typos) against a separately written reference, variant by variant | exactly equal to the reference: nothing missed, nothing extra |
| Search speed | 2,000 / 5,000 / 10,000 variants on this PC | build 0.18 / 0.22 / 0.30 s; worst search 4.6 / 20 / 19 ms |
| Device engine | 30 simultaneous document writes; failed writes; Dexie upgrade v5 → v6 with data; poison commands | numbers unique and gap-free; nothing lost; found problem 5 |
| Migrations | every revision down and up again, base → head, with data seeded | all reversible; `0007` seeds 5 groups |
| Screens in WebKit | every screen (24 routes + filters, presentation home/list/product/cart/PIN) in both iPad orientations: targets under 44 px, controls without a name, pictures without `alt`, sideways scroll, off-screen elements, `lang`/`dir`, title, colour-only badges, console errors | 0 console errors, 0 unnamed controls, 0 sideways scroll; only 4 small check boxes (see "checked and fine") |
| Headers / proxy | spoofed `X-Forwarded-For` against the login limit, through the real Cloudflare tunnel | found problem 4 below, verified fixed |

## Problems found and fixed
| # | Severity | What | How it was found | Fix | Test |
| --- | --- | --- | --- | --- | --- |
| 1 | **High** (low likelihood) | A **NUL character** (`\u0000`) in any text of a command made the server answer 500 for the **whole push**; the command was never recorded, so the iPad re-sent the same batch for ever and **nothing behind it ever synced**. A pasted barcode or a broken keyboard app can type one. | command fuzz | the server refuses such a command cleanly (`VALIDATION_ERROR`), scrubs echoed text before storing a rejection, and any database refusal (`DataError`) becomes a recorded rejection; REST gets the same answer (422) | `test_qa_adversarial.py` |
| 2 | Low | A hand-made pagination `cursor` could crash the products / variants / movements lists (500) | query fuzz | cursors are decoded with types; anything wrong is `422 BAD_CURSOR` | same |
| 3 | Low | A statement period of year 1 or 9999 crashed the time-zone maths (500) | query fuzz | the period must be 2000–2100 (422) | same |
| 4 | **Medium** | **The login limit (5 tries, then 15 minutes) could be skipped** by sending a different made-up `X-Forwarded-For` on every try: 8 wrong passwords in a row all got 401. Proven through the real tunnel. In production Caddy faces the internet directly and overwrites the header, so this bit the tunnel / any proxy in front. | read the proxy chain, then tried it | `Caddyfile`: `trusted_proxies_strict` and `header_up X-Forwarded-For {client_ip}`; verified: spoofed attempts now count against the real address, and the API logs the visitor's real address through the tunnel | manual check (needs a proxy chain) |
| 5 | **Medium** | On the device, **one command the server can never take blocked every command behind it for ever** (the same push was retried each minute). | reasoning about problem 1, then a test | a request the server cannot read (400/413/422) is set aside at once and shown on the sync screen as refused (the rep can retry or discard); a crash (500) is retried, and set aside after 3 in a row on that command alone. Network, session, revoked device, 429, 502/503 are untouched. | `sync.test.ts` |
| 6 | Medium on iPad | The search index was rebuilt on **every** change to the catalog snapshot (a stock level, a picture, a waiting command), 0.2 s on this PC and several times that on an iPad | benchmark | the index is cached by the words it is made of, not by the snapshot object | `search.test.ts` |
| 7 | **High likelihood** with the real file | Importer: a price worked out by an Excel formula (`=12*1.3`) arrives as `15.600000000000001` and the row was **refused** ("more than two decimals") | probing the parser with real Excel number forms | floats are rounded to 6 decimals first (real prices have 2); `12.555` is still refused | `test_import.py` |
| 8 | Medium | Importer: a title or blank rows above the header made every column "missing"; a price typed as text with `₪` / `شيكل` was refused; **other sheets of the workbook were silently ignored** | same | the header is the first of the first 15 rows that has every required column (row numbers in errors stay the spreadsheet's); currency marks around a text price are dropped; other sheets with data are named in a warning on the preview | `test_import.py` |
| 9 | Low | Missing browser protections | header check | `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (no camera, microphone, location) | headers checked on the tunnel |

## Checked and found sound
- **Money**: the balance formula, the exact remainder of the last returned unit, refunds, voids, cancels, replays and refused commands all agree on the server and (via shared fixtures and 15 offline histories) on the device.
- **Stock**: the cache always equals the sum of the movements, through sales, cancels, restock/damaged returns, counts and refused commands.
- **Idempotency**: resending any command, even interleaved, changes nothing and answers the same.
- **Sync**: reading in small pages equals reading everything; a transaction is never split across pages.
- **Concurrency on the device**: 30 documents started at once get 30 different, consecutive numbers; a failed write uses no number.
- **Upgrade of stored data**: a device holding the old (v5) database keeps its counters, cursor, waiting commands and catalog when the app opens it as v6.
- **Authentication**: all routes, CSRF, cookie flags (`HttpOnly`, `Secure`, `SameSite=Lax`), argon2, device revocation.
- **Uploads**: images limited by size and pixels and re-encoded; spreadsheets limited by size, rows and unzipped size (zip bomb).
- **RTL / language**: no physical left/right classes anywhere; the only Arabic text in code outside `i18n` is the normalization table and the placeholder business name; `lang="ar" dir="rtl"` on every screen.
- **Touch targets**: the 4 reported "small" items are check boxes (20–24 px) inside a label row that is 48 px tall and tappable as a whole; not a real problem (enlarging the box is cosmetic).
- **Bundle**: initial JS 200.9 KB gzip, budget 250.

## Risks that remain (not code, or needing a decision)
Ordered by what I would worry about first. "Early sign" is what you would see before it hurts.

| # | Risk | Likelihood × impact | Early sign | Recommendation |
| --- | --- | --- | --- | --- |
| R1 | **No backups, no tested restore** (`docs/RESTORE.md` is a stub; M9) | certain gap × catastrophic if the server disk dies | n/a | Do M9's `pg_dump` + restore drill **before** entering real data. Until then treat every installation as disposable. |
| R2 | **Dashboard, reports and export are not built** (F12, F13: the nav shows "قيد التطوير") | certain × medium (the client expects them) | the empty screens | Decide whether they are in the first release; if yes they need their own milestone before M9 closes. |
| R3 | **A wrong iPad clock writes wrong dates**: documents are dated by the device, the server accepts any date (year 9999 passes validation). A banner warns but does not stop a sale. | low × medium (invoices in the wrong statement period) | the "clock off" banner | Server: refuse or flag dates more than a few days from server time; device: block checkout while the skew is large. |
| R4 | **Daylight-saving rules**: the API container uses the operating system's time-zone data (no `tzdata` package). Palestine announces its dates each year; an old image can be an hour off near the change. | medium over the years × low | statements near late March / late October showing a transaction on the wrong day | add the `tzdata` package to `requirements.txt` and rebuild the image twice a year. |
| R5 | **The real Excel file is unknown**; the importer is strict by design (all rows or nothing; first sheet only; category column required; duplicates refused). Fixes 7 and 8 cover the common traps. | high that *something* in it needs attention × low (it refuses, loses nothing) | the preview's error list | Get the file early; import it into a scratch database and read the preview before M9. |
| R6 | **Returns against invoices older than 12 months** cannot be made on the device (known, `M7-NOTES`) | low × low | "invoice not found" on a very old sale | build `GET /invoices/{id}` fallback when the client asks. |
| R7 | **No full Content-Security-Policy** (only `frame-ancestors`). The picture export draws with inline styles, so a strict policy must be tested on the iPad first. | low × medium (XSS would be needed first; none found) | n/a | add as `Content-Security-Policy-Report-Only` first. |
| R8 | **HEIC photos**: the SPEC asks for them, the server refuses them (Safari normally converts to JPEG on upload; confirmed working on the iPad in M2). | low × low | "unsupported image" on a photo | keep; or add `pillow-heif`. |
| R9 | **Local data is not encrypted and the PIN hash can be brute-forced** if someone extracts the iPad storage (stated in the SPEC). | low × high | n/a | the iPad passcode is the real protection: make it a requirement at hand-over. |
| R10 | **The login limit lives in memory** (resets on restart, needs a single worker). | low × low | n/a | fine for one rep; note it if the API is ever scaled. |
| R11 | **Containers**: images are not pinned to a version (`postgres:16`, `caddy:2`), the API runs as root, no healthchecks on `api` / `caddy`. | low × low | a surprise upgrade | pin versions and add `USER`/healthchecks in M9. |
| R12 | **/media is public** by URL (unguessable ids, no listing). | low × low | n/a | acceptable for product photos; do not put anything private there. |

## What this QA could not cover
- The real iPad: touch feel, scroll speed, Home-Screen eviction, camera upload, WhatsApp hand-off, service-worker updates on iOS. WebKit on a PC is close, not the same.
- PDF rendering on this Windows machine (it needs the Linux libraries): it runs in the container and in CI, where it is green.
- The client's real data, and anything under real load or with two people at once (the product is single-user by design).
- Time-based behaviour over days (session sliding expiry, the 24-hour pending warning) beyond what unit tests simulate.

## Suggested order before M9
1. Merge this QA branch (fixes + tests); try the importer fixes on the iPad with a messy sample (title row, text prices).
2. Decide R2 (reports/export in or out) and R3 (clock rules).
3. M9: backups + restore drill (R1), `tzdata` (R4), image pinning (R11), then the client's file into a scratch database (R5), and only then real data.
