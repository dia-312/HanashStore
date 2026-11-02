#!/bin/sh
# Nightly: forget old backups by the retention rules and check the repository. The database is
# kept: the last 12 backups (two days), one a day for 30 days, one a month for a year. The
# pictures, which only grow, a week of days, a month of weeks, half a year of months.
set -eu
. /etc/backup.env

ping() { [ -z "${HC_URL:-}" ] || curl -fsS -m 15 --retry 2 "${HC_URL}${1:-}" > /dev/null 2>&1 || true; }
STEP="starting"
trap 'rc=$?; [ "$rc" -eq 0 ] || { echo "PRUNE FAILED during: $STEP (exit $rc)" >&2; ping /fail; }' EXIT

STEP="forgetting old database backups"
restic forget --tag db --group-by host,tags --keep-last 12 --keep-daily 30 --keep-monthly 12
STEP="forgetting old picture backups"
restic forget --tag media --group-by host,tags --keep-daily 7 --keep-weekly 4 --keep-monthly 6
STEP="removing what nothing needs any more"
restic prune --quiet

# Once a week (Sundays) read a tenth of the stored data back to prove it is intact.
if [ "$(date +%u)" = "7" ]; then
  STEP="checking the stored data"
  restic check --read-data-subset=10%
else
  STEP="checking the repository structure"
  restic check
fi
echo "prune and check finished $(date '+%Y-%m-%d %H:%M:%S %Z')"
