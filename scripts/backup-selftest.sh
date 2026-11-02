#!/usr/bin/env bash
# Proves the whole backup path on this machine, with the real production images and a local S3
# server in place of Cloudflare R2: sample books -> first backup -> restore drill -> a damaged copy
# must FAIL the drill -> pruning. Everything is thrown away at the end.
#   bash scripts/backup-selftest.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1 # Git Bash on Windows would rewrite /var/... paths given to docker

export ENV_FILE=ops/backup/selftest.env
export COMPOSE="docker compose -p hanash-bk --env-file $ENV_FILE -f docker-compose.prod.yml -f ops/backup/docker-compose.selftest.yml"
cleanup() { $COMPOSE down -v > /dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

wait_for() { # description, then a command that succeeds when ready
  local what=$1; shift
  for _ in $(seq 1 90); do "$@" > /dev/null 2>&1 && return 0; sleep 2; done
  echo "timed out waiting for: $what" >&2; $COMPOSE logs --tail 40 >&2; return 1
}

echo "== starting the database, the API and a local S3 server"
$COMPOSE up -d --build postgres api s3
wait_for "the API" $COMPOSE exec -T api python -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"

echo "== making sample books through the API"
$COMPOSE exec -T -e ADMIN_PASSWORD=selftest-login-password api python -m app.cli create-user --name selftest
$COMPOSE exec -T -e ADMIN_PASSWORD=selftest-login-password api python -m scripts.sample_books
# a picture, so the picture backup has something in it
$COMPOSE exec -T api sh -c 'mkdir -p /data/media/p && head -c 2048 /dev/urandom > /data/media/p/test-picture.webp'

echo "== the books, as the app itself sees them"
$COMPOSE exec -T api python -m app.cli check-books

echo "== starting the backup service (it makes the first backup at once)"
$COMPOSE up -d --build backup
wait_for "the first backup" $COMPOSE exec -T backup test -f /var/lib/backup/last-ok
$COMPOSE exec -T backup sh -c '. /etc/backup.env; restic snapshots --compact'
snapshots=$($COMPOSE exec -T backup sh -c '. /etc/backup.env; restic snapshots --json' | tr -d '\r')
echo "$snapshots" | grep -q '"db"' || { echo "no database snapshot" >&2; exit 1; }
echo "$snapshots" | grep -q '"media"' || { echo "no picture snapshot" >&2; exit 1; }

echo "== the repository is encrypted: the stored files do not contain the data"
if $COMPOSE exec -T s3 sh -c 'grep -rl "محل النور" /data 2>/dev/null' | grep -q .; then
  echo "customer names found in the stored backup: NOT encrypted" >&2; exit 1
fi

echo "== a second backup changes nothing it should not (nothing new = a few kilobytes)"
$COMPOSE exec -T backup /ops/backup.sh

echo "== the restore drill on the good backup must pass"
bash scripts/restore-drill.sh

echo "== damage the live books, take a backup of that, and the drill must FAIL"
$COMPOSE exec -T postgres psql -q -U sales -d sales -c "UPDATE product_variants SET stock_qty = stock_qty + 7"
$COMPOSE exec -T backup /ops/backup.sh
if bash scripts/restore-drill.sh; then
  echo "the drill passed a damaged backup: it checks nothing" >&2; exit 1
fi
echo "   (it failed, as it should)"

echo "== a broken repository setting is reported, not swallowed"
if $COMPOSE exec -T -e RESTIC_PASSWORD=wrong backup sh -c 'sed -i "s/^export RESTIC_PASSWORD=.*/export RESTIC_PASSWORD=wrong/" /etc/backup.env; /ops/backup.sh'; then
  echo "a wrong password was accepted" >&2; exit 1
fi
echo "   (it failed, as it should)"
echo "== a wrong bucket must not get a new repository (the old one is known to have existed)"
if $COMPOSE exec -T backup sh -c 'sed -i "s#^export RESTIC_REPOSITORY=.*#export RESTIC_REPOSITORY=s3:http://s3:9000/some-other-bucket#; s#^export RESTIC_PASSWORD=.*#export RESTIC_PASSWORD=selftest-restic-password#" /etc/backup.env; /ops/backup.sh'; then
  echo "a backup into a bucket that has no repository was accepted" >&2; exit 1
fi
echo "   (it failed, as it should)"
$COMPOSE exec -T backup sh -c 'sed -i "s#^export RESTIC_REPOSITORY=.*#export RESTIC_REPOSITORY=s3:http://s3:9000/hanash-backup#" /etc/backup.env'

echo "== pruning with the retention rules"
$COMPOSE exec -T backup sh -c 'sed -i "s/^export RESTIC_PASSWORD=.*/export RESTIC_PASSWORD=selftest-restic-password/" /etc/backup.env'
$COMPOSE exec -T backup /ops/prune.sh

echo "SELFTEST OK"
