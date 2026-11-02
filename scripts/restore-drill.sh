#!/usr/bin/env bash
# The restore drill (docs/RESTORE.md): proves that the NEWEST backup is not just a file but a
# working set of books. It restores the backup into a scratch database next to the real one, which
# it never touches, runs the books check on that copy, counts the pictures, and drops the copy.
# Run it once a month, and after any change to the backup setup. Exit code 0 = the backup is good.
#
#   bash scripts/restore-drill.sh
# (COMPOSE and ENV_FILE can be overridden; the defaults are the production ones.)
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1 # Git Bash on Windows would rewrite /var/... paths given to docker

COMPOSE=${COMPOSE:-docker compose -f docker-compose.prod.yml}
ENV_FILE=${ENV_FILE:-.env}
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

echo "== 1. restoring the newest database backup into a scratch database"
name=$($COMPOSE exec -T backup /ops/drill.sh restore)
echo "   scratch database: $name"
cleanup() { $COMPOSE exec -T backup /ops/drill.sh drop "$name" || true; }
trap cleanup EXIT

echo "== 2. checking the books in the copy"
$COMPOSE run --rm -T \
  -e "DATABASE_URL=postgresql+psycopg://${POSTGRES_USER:-sales}:${POSTGRES_PASSWORD}@postgres:5432/${name}" \
  api python -m app.cli check-books

echo "== 3. the pictures in the newest picture backup"
pictures=$($COMPOSE exec -T backup /ops/drill.sh pictures)
echo "   $pictures picture files"

echo "== 4. the newest backups"
$COMPOSE exec -T backup sh -c '. /etc/backup.env; restic snapshots --latest 2 --compact'

echo "DRILL OK: the newest backup restores and its books are consistent"
