# HanashStore

An offline-first sales app for one wholesale sales rep (hookahs, hoses, charcoal and accessories), built to run
on his iPad as a Home Screen app: a catalog he hands to the customer, invoices and payments that work
without internet, statements and invoices sent on WhatsApp, and reports. Arabic, right to left.

- `apps/web`: the app (Vite, React, TypeScript, Tailwind, Dexie, Zustand).
- `apps/api`: the server (FastAPI, SQLAlchemy, Alembic, PostgreSQL 16).
- `ops/`, `docker-compose*.yml`, `Caddyfile`: running it (development, tests, production, backups).
- `docs/`: the specification (`SPEC.md`), one notes file per milestone, `DEPLOY.md`, `RESTORE.md`, `QA-REPORT.md`.
- `CLAUDE.md`: the working rules and the commands (`npm test`, `pytest`, `bash scripts/e2e.sh`, ...).

## Rights

© 2026 **Diaa Arar (ضياء عرار)**. All rights reserved. See [LICENSE](LICENSE): the code may not be copied,
modified, distributed or hosted for others without his written permission.

جميع الحقوق محفوظة © 2026 ضياء عرار.
