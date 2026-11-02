# M8 — Search and full presentation mode: notes

Branch `m8-search-presentation` (from `main` after PR 9). **Status: built, checked on the PC (unit, screen and WebKit tests) and tried on the real iPad by the user (after the presentation-mode change below).**
Done when (SPEC section 15): all section 9 test cases pass, and nothing from the "never shown" list is reachable in presentation mode. Both are tests now (see below).

## What exists
- **Search engine** (`lib/search.ts`, MiniSearch 7): one document per active variant, made of the normalized product name, category, colour, size, SKU and description (separate fields with weights: SKU 4, name 3, colour/size 2, category 1.5, description 0.5). Every typed word must be found (AND), as a prefix, with one typo allowed on words of 4+ characters; each word also stands for the other words of its synonym groups (OR inside the word, AND between words). An exact SKU in any case always comes first. A product with no variant yet is still found by its name. The index is built once per snapshot (a `WeakMap`), so typing never rebuilds it. Results are grouped per product with the variants that matched.
- **Synonyms**: table `synonym_groups` (migration `0007`, seeded with the five groups of SPEC section 9, terms already normalized), rides the pull like every synced table (`is_active` for removals), Dexie v6. `GET /synonyms` and `PUT /synonyms` (the whole list at once: a group with an id is updated, without one is created, one left out is switched off, never deleted; terms are normalized and de-duplicated; fewer than two different words = `VALIDATION_ERROR`; an unknown id = 404; saving the same list changes nothing for devices; every change is audited). Settings → "كلمات البحث المتشابهة" edits them (online only, one line per group, words separated by commas).
- **Catalog**: the old "every word is in the text" match is gone. Filters (combinable, a product is listed when one of its variants fits all of the variant filters): category, colour, size, availability (متوفر / منخفض / نفد, with symbols), price range (typed digits of any kind are understood, a bad number is said so). Order: relevance (default when searching), name, best-selling (units on confirmed invoices of the last 90 days, read from the device), newest, price low/high. When the words or filters pick only some of a product's variants the tile says which ("مطابق: أسود") and the product page opens on them with those variants framed and marked "مطابق للبحث". The filters stay while the rep is in the catalog (also on a product page) and are reset when he leaves it (`Shell` → `resetCatalogFilters`) or taps "مسح الفلاتر".
- **Stock picker** (`buildVariantList`) uses the same engine, so "فحم 25" finds that variant.
- **Presentation mode**: search with the same engine (synonyms, typos, variant words, colours included); the product page is `ProductDetail`: pictures that swipe (scroll-snap, dots, the product's pictures first and then those of single variants), **size buttons only** (the colour is not a step, and there is no colour filter in the list), and one card for the chosen variant with price, availability badge and add / stepper. Found on the iPad, twice: the first version chose a size when a colour was tapped; the second asked for colour and size separately, which failed for colours that do not come in every size, so the user asked for sizes only. Rules now: nothing is picked for the customer (a product with one variant is chosen already, and so is a variant a search picked); until he picks, the card shows the price range and a prompt ("اختر المقاس", or "اختر الصنف" when the product has no sizes and the variants are told apart by colour); the label of a button is the size, and the colour is added to it only when two variants share a size ("صغير · أسود"), so they can still be told apart. The chosen variant's picture slides into view. The grid is 3 columns in portrait and 4 in landscape (unchanged `VirtualGrid`).
- **Never shown** (SPEC section 10), now a test that walks home → product → cart sheet: no `<a>`, no `<nav>`, none of the menu labels, no balance, no invoice number or total, no other customer, no sync text, no shelf quantity.

## Decisions
- **MiniSearch** is in the SPEC's stack but was not installed until now. +9.5 KB gzip on the first load (initial JS 200.6 KB, budget 250).
- **"Newest"** sorts by product id: ids are UUIDv7, so a larger id was made later. No new column and no re-pull of old rows.
- **Fuzzy only on words of 4+ characters**, as the SPEC says, so a two-letter word like "لي" is exact (it is also a synonym of بربيش).
- **Prefix on every word**, also numbers: "فحم 25" would also find size 250. Kept as the SPEC states it.
- **Highlighting** only when the words picked some, not all, of a product's variants; otherwise every row would be framed and mean nothing. Marked with a frame, a symbol and the word, not colour alone.
- **Synonym groups are shared words, not per-product**; a word may be in more than one group (both groups apply).
- Presentation has no colour step or colour filter (the user's decision after trying it on the iPad). Colours still count in the search and in the labels where sizes alone would be ambiguous.

## Checked on the PC
| Check | Result |
| --- | --- |
| Section 9 required cases | `lib/search.test.ts`: ارجيله, اركيلة (synonym), شيشة (synonym), بربيش اسود (black hose variants only), ارج (prefix), ارجيلا (typo), فحم ٢٥ (Arabic digit → size 25 only), SKU in any case first (also above a product whose name has the same words); plus any word order, every word needed, switched-off group, short words not corrected, category and description, product without variants, stopped variant, empty query |
| Speed | 2,000 variants, worst of 7 queries under 50 ms (asserted in the test) |
| Other tests | filters, sorts, facets, best-selling window, matched variants (`localCatalog.test.ts`); catalog screen: chips, price range, sort, persistence and reset, match hint and link (`Catalog.test.tsx`); presentation: synonym search, variant preselected, colour chips, gallery, size/colour switching, "never shown" (`Present.test.tsx`); synonym screen and pull of groups (`Synonyms.test.tsx`); API: `tests/test_synonyms.py` (9) and the pull shape |
| WebKit journey | see the numbers in the PR; one new journey: synonym and typo search, "مطابق: أزرق", colour filter and clear, price order, a group added in Settings reaching the device and working, the same search offline, presentation search + colour + price, no links on the page, PIN to leave |

## Not done / known
- The seed synonyms are the SPEC's five; the client may want more words (he can add them in Settings).
- No "recent searches" or search suggestions (not in the SPEC).
- Customer search (`customers.search_text`) still uses the old simple matching; the SPEC's engine is about the catalog.
- The best-selling order reads the last 90 days from the device, which keeps 12 months of invoices.
