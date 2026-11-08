#!/usr/bin/env bash
# Tests scripts/update.sh without Docker or a network: a throwaway git remote, a "server" clone, and
# stand-ins for `docker` and `curl` that behave according to files in the test folder.
#   bash scripts/update.test.sh
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

shims="$work/shims"
mkdir -p "$shims"
export SHIM_LOG="$work/calls.log"
export SERVER="$work/server"

# docker: records every call; `exec ... backup` fails while the file backup_fails exists.
cat >"$shims/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$SHIM_LOG"
case "$*" in
  *"exec"*"backup"*) [ ! -e "$SERVER/../backup_fails" ] || exit 1 ;;
esac
exit 0
EOF
# curl: the site answers ok unless the checked-out folder holds BROKEN, or always_bad exists.
cat >"$shims/curl" <<'EOF'
#!/usr/bin/env bash
if [ -e "$SERVER/BROKEN" ] || [ -e "$SERVER/../always_bad" ]; then exit 22; fi
echo '{"status":"ok"}'
EOF
chmod +x "$shims/docker" "$shims/curl"
export PATH="$shims:$PATH"

g() { git -c user.name=test -c user.email=test@example.com "$@"; }

git init -q --bare -b main "$work/remote.git"
git clone -q "$work/remote.git" "$SERVER" 2>/dev/null
mkdir -p "$SERVER/scripts" "$SERVER/apps/api/alembic/versions"
cp "$here/update.sh" "$SERVER/scripts/update.sh"
echo "services: {}" >"$SERVER/docker-compose.prod.yml"
echo "v1" >"$SERVER/app.txt"
(cd "$SERVER" && g checkout -q -B main && g add -A && g commit -q -m "v1" && g push -q origin main)
printf 'DOMAIN=test.invalid\n' >"$SERVER/.env"
git clone -q "$work/remote.git" "$work/dev" 2>/dev/null

export HEALTH_WAIT=2 HEALTH_STEP=1
pass=0
fail=0
ok() { pass=$((pass + 1)); echo "  ok   $1"; }
bad() { fail=$((fail + 1)); echo "  FAIL $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

head_of() { git -C "$SERVER" rev-parse HEAD; }
remote_head() { git -C "$work/dev" fetch -q origin && git -C "$work/dev" rev-parse origin/main; }
publish() { # publish <message> [file to add]
  (cd "$work/dev" && g pull -q origin main && { [ -z "${2:-}" ] || { mkdir -p "$(dirname "$2")"; echo x >"$2"; }; } &&
    echo "$1" >>app.txt && g add -A && g commit -q -m "$1" && g push -q origin main)
}
run() { # run <input to the question> [update.sh arguments]
  local answer=$1
  shift
  : >"$SHIM_LOG"
  out=$(cd "$SERVER" && printf '%s\n' "$answer" | bash scripts/update.sh "$@" 2>&1)
  code=$?
}

echo "nothing new"
run n
check "exits 0 and says it is up to date" '[ $code -eq 0 ] && echo "$out" | grep -q "Already up to date"'
check "touches nothing" '! grep -q "up -d" "$SHIM_LOG"'

echo "a good update"
publish "v2"
before=$(head_of)
run y
check "exits 0" '[ $code -eq 0 ]'
check "moves to the new commit" '[ "$(head_of)" = "$(remote_head)" ] && [ "$(head_of)" != "$before" ]'
check "backs up before it rebuilds" '[ "$(grep -n "backup" "$SHIM_LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n "up -d" "$SHIM_LOG" | head -1 | cut -d: -f1)" ]'
check "says UPDATED" 'echo "$out" | grep -q "^UPDATED"'

echo "not confirmed"
publish "v3"
before=$(head_of)
run n
check "stops with 3 and changes nothing" '[ $code -eq 3 ] && [ "$(head_of)" = "$before" ] && ! grep -q "up -d" "$SHIM_LOG"'

echo "the backup fails"
touch "$work/backup_fails"
run y
check "stops with 3 before touching anything" '[ $code -eq 3 ] && [ "$(head_of)" = "$before" ] && ! grep -q "up -d" "$SHIM_LOG"'
rm "$work/backup_fails"

echo "local changes in the folder"
echo dirty >>"$SERVER/app.txt"
run y
check "refuses (3) and leaves the change alone" '[ $code -eq 3 ] && [ "$(head_of)" = "$before" ] && grep -q dirty "$SERVER/app.txt"'
(cd "$SERVER" && git checkout -q -- app.txt)

echo "an update that touches the database"
publish "v4 with a migration" apps/api/alembic/versions/0099_test.py
run n
check "says so before asking" 'echo "$out" | grep -q "touch the database" && echo "$out" | grep -q 0099_test.py'
run y
check "still updates" '[ $code -eq 0 ] && [ "$(head_of)" = "$(remote_head)" ]'

echo "a broken update"
publish "v5 broken" BROKEN
good=$(head_of)
run y
check "exits 1" '[ $code -eq 1 ]'
check "puts the old version back" '[ "$(head_of)" = "$good" ] && [ ! -e "$SERVER/BROKEN" ]'
check "rebuilds twice (new, then old)" '[ "$(grep -c "up -d" "$SHIM_LOG")" -eq 2 ]'
check "says ROLLED BACK" 'echo "$out" | grep -q "ROLLED BACK"'

echo "the old version does not come back either"
touch "$work/always_bad"
run y
check "exits 2 and says so" '[ $code -eq 2 ] && echo "$out" | grep -q "did not come back"'
rm "$work/always_bad"

echo "a rewritten history"
(cd "$work/dev" && g reset -q --hard HEAD~2 && echo "other" >other.txt && g add -A && g commit -q -m "rewritten" && g push -q -f origin main)
run y
check "refuses (3)" '[ $code -eq 3 ] && echo "$out" | grep -q "history"'

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
