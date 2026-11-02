#!/bin/sh
# One backup: the database (custom format, restorable with pg_restore) and the product pictures,
# encrypted and sent to the repository. Tells healthchecks.io (HC_URL) when it starts, when it
# succeeds and when it fails; a backup that stops quietly is the usual way to lose data.
set -eu
. /etc/backup.env

ping() { [ -z "${HC_URL:-}" ] || curl -fsS -m 15 --retry 2 "${HC_URL}${1:-}" > /dev/null 2>&1 || true; }

STEP="starting"
finish() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "BACKUP FAILED during: $STEP (exit $rc)" >&2
    ping /fail
  fi
}
trap finish EXIT

ping /start
echo "backup started $(date '+%Y-%m-%d %H:%M:%S %Z')"

STEP="the repository (is it reachable, does it exist?)"
if ! out=$(restic cat config 2>&1); then
  # A new repository is made ONLY on purpose, once: BACKUP_INIT=true on the very first start. Never
  # by itself: a wrong bucket name or wrong keys also look like "no repository here", and creating
  # one there would make "successful" backups into the wrong place. A repository that used to be
  # here and is gone is never recreated either: that needs a person.
  case "$out" in
    *"Is there a repository at the following location"*)
      if [ -e /var/lib/backup/repo-seen ]; then
        echo "the backup repository that was here before is gone: refusing to make a new one" >&2
        echo "$out" >&2
        exit 1
      fi
      if [ "${BACKUP_INIT:-}" != "true" ]; then
        echo "there is no backup repository here. If this is the very first start, set" >&2
        echo "BACKUP_INIT=true in .env, start again, then remove it. Otherwise check the" >&2
        echo "bucket name and keys." >&2
        echo "$out" >&2
        exit 1
      fi
      echo "no repository yet: creating it (BACKUP_INIT=true)"
      restic init
      ;;
    *)
      echo "$out" >&2
      exit 1
      ;;
  esac
fi
touch /var/lib/backup/repo-seen

STEP="dumping the database"
dump=/tmp/sales.dump
rm -f "$dump"
pg_dump --format=custom --no-owner --file="$dump"
[ -s "$dump" ] || { echo "the dump is empty" >&2; exit 1; }
pg_restore --list "$dump" > /dev/null # the file is a readable archive

STEP="sending the database"
restic backup "$dump" --tag db --host sales --quiet
rm -f "$dump"

if [ -d /media ]; then
  STEP="sending the pictures"
  restic backup /media --tag media --host sales --quiet
fi

STEP="done"
date +%s > /var/lib/backup/last-ok
touch /var/lib/backup/last-ok
echo "backup finished $(date '+%Y-%m-%d %H:%M:%S %Z')"
ping ""
