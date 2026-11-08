#!/usr/bin/env bash
# Updates the production server to the newest `main`, and goes back to the version that was running
# if the new one does not come up healthy (docs/DEPLOY.md, "Updates" and "Rolling back").
#
#   bash scripts/update.sh        shows what will change and asks before it does anything
#   bash scripts/update.sh -y     does not ask
#
# What it does, in this order: checks the folder is clean and on main, fetches, lists the new
# commits (and says if they change the database), takes a backup, pulls, rebuilds, waits for
# https://$DOMAIN/api/health to answer ok, and otherwise puts the old version back.
#
# Exit code: 0 updated (or nothing to do) | 1 the new version was not healthy and the old one is back
#            2 the new version was not healthy and the old one did not come back either
#            3 stopped before anything was changed
# Settings (environment): COMPOSE, ENV_FILE, REMOTE, BRANCH, HEALTH_WAIT (seconds to wait for the
# site, 150), HEALTH_STEP (seconds between tries, 3), SKIP_BACKUP=1 (not advised).
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=${COMPOSE:-docker compose -f docker-compose.prod.yml}
ENV_FILE=${ENV_FILE:-.env}
REMOTE=${REMOTE:-origin}
BRANCH=${BRANCH:-main}
HEALTH_WAIT=${HEALTH_WAIT:-150}
HEALTH_STEP=${HEALTH_STEP:-3}
YES=
[ "${1:-}" = "-y" ] && YES=1

say() { printf '%s\n' "$*"; }
stop() {
  say "STOPPED, nothing was changed: $*"
  exit 3
}

[ -f "$ENV_FILE" ] || stop "there is no $ENV_FILE in $(pwd)"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
[ -n "${DOMAIN:-}" ] || stop "DOMAIN is not set in $ENV_FILE"

[ -z "$(git status --porcelain --untracked-files=no)" ] ||
  stop "the folder has local changes (git status): put them away first"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || stop "the folder is not on $BRANCH"
git fetch -q "$REMOTE" "$BRANCH" || stop "cannot reach $REMOTE"

old=$(git rev-parse HEAD)
new=$(git rev-parse "$REMOTE/$BRANCH")
if [ "$old" = "$new" ]; then
  say "Already up to date ($(git rev-parse --short HEAD))."
  exit 0
fi
git merge-base --is-ancestor "$old" "$new" ||
  stop "the server's version is not part of $REMOTE/$BRANCH (was the history rewritten?)"

say "Running now: $(git log -1 --format='%h %s' "$old")"
say "Going to:    $(git log -1 --format='%h %s' "$new")"
say "New commits:"
git log --oneline "$old..$new" | head -20 | sed 's/^/  /'
migrations=$(git diff --name-only "$old" "$new" -- apps/api/alembic/versions)
if [ -n "$migrations" ]; then
  say "These changes touch the database (migrations run when the API starts):"
  printf '  %s\n' $migrations
  say "Going back restores the code, not the database (docs/DEPLOY.md, 'Rolling back')."
fi

if [ -z "$YES" ]; then
  read -r -p "Continue? [y/N] " answer
  [ "$answer" = y ] || stop "not confirmed"
fi

if [ -z "${SKIP_BACKUP:-}" ]; then
  say "== 1. backup before the update"
  $COMPOSE exec -T backup /ops/backup.sh ||
    stop "the backup failed: fix that first ($COMPOSE logs backup)"
fi

# The site is healthy when the page everyone goes through (Caddy, the API and the database) says ok.
healthy() {
  local deadline=$((SECONDS + HEALTH_WAIT)) body
  while :; do
    if body=$(curl -fsS --max-time 10 "https://$DOMAIN/api/health" 2>/dev/null) &&
      printf '%s' "$body" | grep -q '"status":"ok"'; then
      return 0
    fi
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep "$HEALTH_STEP"
  done
}

say "== 2. updating to $(git rev-parse --short "$new")"
git merge --ff-only -q "$REMOTE/$BRANCH" || stop "could not move to $REMOTE/$BRANCH"
if $COMPOSE up -d --build && healthy; then
  $COMPOSE ps
  say "UPDATED to $(git log -1 --format='%h %s')"
  exit 0
fi

say "== the new version is not healthy: going back to $(git rev-parse --short "$old")"
git reset --hard -q "$old"
if $COMPOSE up -d --build && healthy; then
  $COMPOSE ps
  say "ROLLED BACK: the old version is running again. Look at: $COMPOSE logs --tail 100 api"
  exit 1
fi
say "!! The old version did not come back healthy either."
say "   Look at: $COMPOSE logs --tail 100 api caddy   and   docs/DEPLOY.md, 'Rolling back'."
exit 2
