#!/bin/sh
# Starts the backup schedule. The jobs run from cron, which does not pass the environment on, so it
# is written once to /etc/backup.env for the scripts to read.
set -eu

: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY (an s3:... or other restic repository)}"
: "${RESTIC_PASSWORD:?set RESTIC_PASSWORD (encrypts the backups; keep a copy somewhere safe)}"
: "${PGHOST:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${PGDATABASE:?}"

: > /etc/backup.env
chmod 600 /etc/backup.env
for name in RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
            AWS_DEFAULT_REGION BACKUP_INIT PGHOST PGUSER PGPASSWORD PGDATABASE HC_URL TZ; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || continue
  escaped=$(printf %s "$value" | sed "s/'/'\\\\''/g")
  printf "export %s='%s'\n" "$name" "$escaped" >> /etc/backup.env
done

# every 4 hours at :15; the pruning and the repository check once a night
cat > /etc/crontabs/root <<'EOF'
15 */4 * * * /ops/backup.sh > /proc/1/fd/1 2>&1
45 3 * * * /ops/prune.sh > /proc/1/fd/1 2>&1
EOF

# one backup at once, so a mistake in the settings shows up now and not at the first schedule
/ops/backup.sh || echo "the first backup failed: see above; the schedule continues" >&2

exec crond -f -l 8
