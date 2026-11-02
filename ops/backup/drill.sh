#!/bin/sh
# The restore drill, step by step (the host script scripts/restore-drill.sh drives it):
#   drill.sh restore        restores the newest database backup into a NEW scratch database,
#                           never the real one, and prints that database's name
#   drill.sh drop NAME      deletes a scratch database made by the drill
#   drill.sh pictures       counts the picture files in the newest picture backup
# A backup that has never been restored is a hope, not a backup.
set -eu
. /etc/backup.env

case "${1:-}" in
  restore)
    name="drill_$(date +%Y%m%d_%H%M%S)"
    psql --quiet --dbname=postgres -c "CREATE DATABASE \"$name\"" >&2
    # --exit-on-error: a damaged backup must fail the drill, not be shrugged off
    if ! restic dump latest /tmp/sales.dump --tag db --host sales \
         | pg_restore --no-owner --exit-on-error --dbname="$name" >&2; then
      echo "could not restore the newest backup" >&2
      psql --quiet --dbname=postgres -c "DROP DATABASE IF EXISTS \"$name\"" >&2 || true
      exit 1
    fi
    echo "$name"
    ;;
  drop)
    name="${2:?which scratch database?}"
    case "$name" in drill_*) ;; *) echo "refusing to drop '$name': not a drill database" >&2; exit 2 ;; esac
    psql --quiet --dbname=postgres -c "DROP DATABASE IF EXISTS \"$name\"" >&2
    ;;
  pictures)
    restic ls latest --tag media --host sales | grep -c '^/media/.' || true
    ;;
  *)
    echo "usage: drill.sh restore | drop NAME | pictures" >&2
    exit 2
    ;;
esac
