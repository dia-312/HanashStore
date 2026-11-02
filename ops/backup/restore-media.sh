#!/bin/sh
# Puts the newest picture backup into the pictures volume, mounted writable at /restore. Used when a
# server is rebuilt (docs/RESTORE.md). Run as a one-off container, not through the schedule:
#   docker compose -f docker-compose.prod.yml run --rm --no-deps -v hanash_media:/restore \
#     --entrypoint /ops/restore-media.sh backup
set -eu
rm -rf /restore-tmp
restic restore latest --tag media --host sales --target /restore-tmp
cp -a /restore-tmp/media/. /restore/
chown -R 10001:10001 /restore # the API runs as this user
echo "pictures restored: $(find /restore -type f | wc -l) files"
