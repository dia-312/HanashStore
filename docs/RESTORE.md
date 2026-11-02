# Backups and restoring

## What is backed up, where
Every 4 hours the `backup` service (`ops/backup`) makes **one dump of the database** and **copies the product
pictures**, encrypts them (restic, with `RESTIC_PASSWORD`) and stores them in a bucket **outside the server**
(`RESTIC_REPOSITORY`). It tells your health-check address when it starts and when it finishes, and when it
fails, so a backup that quietly stops makes an email arrive. Retention: the database keeps the 12 newest
backups (two days), one a day for 30 days and one a month for a year; the pictures a week of days, a month of
weeks and half a year of months.

What a backup can NOT save you from: work done after the last backup (at most about 4 hours) if the server is
lost. Work still waiting on an iPad is not lost: see "What the iPad does" below.

## The monthly drill (this is what makes a backup a backup)
```bash
bash scripts/restore-drill.sh
```
It restores the **newest** backup into a scratch database next to the real one (never touching it), runs
`check-books` on the copy (14 rules, written separately from the code that writes the data: invoice lines add up
to the invoice, discount shares to the discount, returns never exceed what was sold, every balance matches the
formula, the stock quantity of every item matches its movements, the sync clock is ahead of every row, …),
counts the picture files, and deletes the copy. **DRILL OK** at the end means the backup restores and its books
are consistent. Any other ending means *do not rely on it*: look at the first line that says what failed, fix
the cause, make a new backup (`docker compose -f docker-compose.prod.yml exec backup /ops/backup.sh`) and run
the drill again.

`scripts/backup-selftest.sh` runs the same path end to end on a development machine with a throwaway local S3
server: sample books, first backup, drill, a **damaged copy that must fail the drill**, a wrong password that
must be refused, and pruning.

## Restoring the real thing

### The database is damaged but the server is fine
1. Stop the app: `docker compose -f docker-compose.prod.yml stop api caddy`.
2. See what there is: `docker compose -f docker-compose.prod.yml exec backup sh -c '. /etc/backup.env; restic snapshots --tag db'`.
   Pick the newest good one (its ID, for example `3f2a9c1d`; `latest` also works).
3. Restore it over the database (this **replaces** what is there; the damaged one is dropped):
   ```bash
   C="docker compose -f docker-compose.prod.yml"
   $C exec -T backup sh -c '. /etc/backup.env; psql -d postgres -c "DROP DATABASE IF EXISTS \"$PGDATABASE\"" -c "CREATE DATABASE \"$PGDATABASE\""'
   $C exec -T backup sh -c '. /etc/backup.env; restic dump 3f2a9c1d /tmp/sales.dump | pg_restore --no-owner --exit-on-error -d "$PGDATABASE"'
   ```
4. Start the API (it migrates the database if the backup was from an older version) and tell the devices:
   ```bash
   $C up -d api
   $C exec api python -m app.cli check-books        # must say: books are consistent
   $C exec api python -m app.cli after-restore       # a new sync epoch: see below
   $C up -d caddy
   ```

### The server is gone
1. Make a new server and follow `docs/DEPLOY.md` steps 1–3 **with the same `.env` values**, above all the same
   `RESTIC_REPOSITORY`, keys and **`RESTIC_PASSWORD`** (this is why you keep a copy of it elsewhere).
2. Start only the database and the backup service: `docker compose -f docker-compose.prod.yml up -d postgres backup`
   (the backup service makes a first backup of the empty database; that is fine, it is simply the newest *empty* one:
   restore a named older snapshot, not `latest`, in the next step).
3. Restore the database as in the previous section, then the pictures into their volume:
   ```bash
   $C run --rm --no-deps -v hanash_media:/restore --entrypoint /ops/restore-media.sh backup
   ```
4. `up -d` everything, `check-books`, `after-restore`, point the domain at the new server's IP.

## What the iPad does after a restore (the "sync epoch")
A restored server is older than what the iPad has read. Without care the iPad would believe it already has rows
that no longer exist, and would never receive new ones numbered the same as ones it already saw. So the server has
an **epoch**, a random number that `after-restore` changes. At its next sync an iPad that sees a new epoch **forgets
everything it had read from the server and reads it all again**, and keeps whatever is waiting to be sent
(unsent sales, payments, counts) and the document numbers it has used.

What you will see: the first sync after a restore takes longer (a full read), and **work that was synced after the
last backup and before the failure is gone from both the server and the iPad**: sales, payments and returns made
in that window (at most about 4 hours) must be entered again (the paper invoices, WhatsApp messages and the
customers' own copies are the sources). Work still in "waiting to be sent" is not lost.

## Keys and secrets: where to keep what
| Secret | Lives | Also keep |
| --- | --- | --- |
| `RESTIC_PASSWORD` | `.env` on the server | **password manager + paper in a safe place**. Lose it and every backup is unreadable. |
| bucket keys | `.env` | the provider's dashboard can issue new ones |
| `POSTGRES_PASSWORD` | `.env` | can be changed (change it in `.env` and in the database: `ALTER USER`) |
| the login password and PIN | the owner | a lost password: `docker compose ... exec -e ADMIN_PASSWORD=... api python -m app.cli` has no reset yet (see below) |

## Not done / known
- There is no command yet to reset the login password; the one user can only be created once. If the password is
  lost, a restore into a new empty database followed by `create-user` is the workaround.
- The drill checks the newest backup only; `restic check` (nightly, with a deeper read on Sundays) checks that the
  stored data itself is intact.
- Point-in-time recovery (to the minute) is not set up: backups are every 4 hours.
