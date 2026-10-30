# M2 — Catalog and stock: notes

Branch `m2-catalog-stock` (from `main`). **Status: built and checked on the PC. iPad check and CI run still open, and the real-Excel criterion is open until the client's file arrives.**
Done when (SPEC section 15): the client's real Excel file imports with correct stock.

## What exists
- Database (migration `0002`): `categories`, `products`, `product_variants`, `product_images`, `stock_movements`, `audit_log`, sequence `sku_seq`, `pg_trgm` and its GIN index on `products.search_text`. Every synced table has `updated_at` and `change_seq`.
- `change_seq`: one number per write transaction from the `sync_clock` row (`UPDATE ... RETURNING`, lock held to commit). `/sync/pull` itself is M3.
- API under `/api/v1`: categories, products (+ variants), `/variants` (picker search), variant edit, `/variants/{id}/movements` (history with running total), images (upload, reorder, soft delete), `/stock/in`, `/stock/adjust`, `/stock/damage`, `/import/products`. Lists use cursor pagination (default 50, max 200).
- Stock: the sum of `stock_movements` is the truth, `stock_qty` is a cache changed only in the same transaction as a movement. Damage and adjustment can't go below zero (`INSUFFICIENT_STOCK`). Every stock request carries client ids; the same id twice has the effect of once (`MOVEMENT_ID_CONFLICT` if reused for something different). `python -m app.cli recompute-stock [--fix]` finds and repairs cache mismatches.
- Images: Pillow decodes and re-encodes everything to WebP (thumb 400 px, full 1200 px), so EXIF/GPS is gone and only JPEG, PNG and WebP content is accepted (by content, not extension). Limits: 10 MB, 40 megapixels, 10 images per product. Files live in the `media` Docker volume, written by `api`, served by Caddy at `/media/` with an immutable cache header (the API also serves `/media` in dev and tests).
- Import: `.xlsx` (read-only, values only, zip-bomb guard) or `.csv` (UTF-8, or Windows Arabic cp1256; comma, semicolon or tab). Columns are recognized by Arabic or English header text (`COLUMN_ALIASES` in `app/services/importer.py`). Dry run reports per-row errors; a real run saves everything or nothing. Re-importing never changes an existing variant (price and stock untouched).
- `normalize_arabic` (Python) and `normalizeArabic` (TypeScript) are both tested against `shared/normalize_cases.json`.
- Web: catalog screen in the main bundle (virtualized grid/list, search, category chips, skeleton on first load, online only). Lazy chunks: product page (info, images, variants with inline price and alert level, add variant, history), stock (stock-in, count, damage), categories, importer. Every confirmation shows its numbers. Status badges use icon + text + colour.
- Seed: `seed_large.py` now also writes `categories.json`; `python -m scripts.load_seed <dir>` loads categories, products, variants, thumbnails and opening stock (400 / 2,000 / 400 images in about 27 s).

## Checked on the PC
| Check | Result |
| --- | --- |
| API tests (pytest, real Postgres 16) | 159 pass |
| ruff, ruff format, mypy (strict) | clean |
| Web tests (Vitest) | 82 pass |
| ESLint (incl. the RTL class ban), Prettier, tsc | clean |
| Initial JS | 165 KB gzip (budget 250 KB). Product page, stock, categories and import are separate chunks |
| API response time, 2,000-variant dataset | about 18 ms for `/products?limit=50` and `/variants?q=`, measured on the API itself and through Caddy (budget: p95 < 200 ms) |
| Compose stack | migration ran on start; photo uploaded through Caddy and served from `/media` with `Cache-Control: public, max-age=31536000, immutable` |
| Built-in browser, real screens | catalog with 400 products in a 5-column grid, product edit (price 887 → 900.50, audit row written), stock-in +10, count to 380 (difference −4), damage −5, history with running totals, importer: a bad row blocks the import, a good file imports; database quantities equal the file exactly and `recompute-stock` reports no mismatch |

A bug found by looking at the real screen, not by the tests: the catalog's width observer never attached (the list appears after the data loads), so the grid stayed at 2 huge columns. Fixed by keeping the scroll element in state.

## Not verified
- **iPad, Home Screen app**: catalog open time (< 300 ms) and scroll smoothness with 400 products, photo from the iPad camera, the other flows by touch.
- **CI**: the workflow has not run on this branch (nothing pushed). The new `/media` check in `compose-smoke` is untested there.
- **The client's real Excel file** (the SPEC's done criterion): not received. Only generated files were imported. If its columns have other names, only `COLUMN_ALIASES` should need to change.
- HEIC upload is not supported (no extra library): the file input lists JPEG/PNG/WebP, which makes iOS convert camera photos itself. Not proven on the device.
- Real-world sorting of Arabic names uses the database collation; not looked at closely.

## Decisions and deviations
- Writes are REST in M2 (SPEC section 15 says stock commands move to the push path in M3). Extra endpoints beyond the section 12 table: `GET /variants`, `POST /stock/in`, `/stock/adjust`, `/stock/damage`.
- Images on local disk behind `app/storage.py` instead of R2 (needs boto3, credentials and a domain; the production deploy is M9). The soft-deleted images' files stay until a cleanup in M9.
- SKU format `SKU-000123` from a sequence, never typed.
- `(product, color, size)` uniqueness uses `NULLS NOT DISTINCT` and treats an empty string as "none", so two variants without color and size can't both exist.
- The variant picker and the server product search match words against the product's text (name, category, description, and all its variants' colors, sizes and SKUs), so searching "بربيش اسود" also lists that product's red variants. Variant-level matching, prefix, synonyms and typo tolerance come with the device search in M8.
- Movement history loads 50 rows at a time with a "show more" button instead of a virtualized list.
- New dependencies: `openpyxl` and `@tanstack/react-virtual` (both in SPEC section 3), `python-multipart` (approved; FastAPI needs it for uploads). No other.
- Windows tip: in Git Bash prefix `docker compose exec` commands that take a `/path` argument with `MSYS_NO_PATHCONV=1`, otherwise the path is rewritten. Truncating `devices` in the dev database cascades to `stock_movements`.
