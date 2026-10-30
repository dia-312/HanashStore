# shared/

Fixtures used by both test suites so the TypeScript and Python copies of a rule can't drift.

Planned (SPEC sections 7 and 9):

- `normalize_cases.json` — input → expected output for `normalizeArabic` / `normalize_arabic` (M8).
- Money, discount allocation and return-amount cases (M4, M7).

Empty in M1: nothing in the foundation needs a shared fixture yet.
