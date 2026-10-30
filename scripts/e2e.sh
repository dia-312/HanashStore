#!/usr/bin/env bash
# Runs the WebKit browser tests against a fresh throwaway stack (docker-compose.e2e.yml).
# Usage: bash scripts/e2e.sh          (builds the web app first)
set -euo pipefail
cd "$(dirname "$0")/.."

compose() { docker compose -p hanash-e2e -f docker-compose.e2e.yml "$@"; }

npm --prefix apps/web run build
compose down -v
compose up -d --build

for _ in $(seq 1 60); do
  curl -fs http://127.0.0.1:8090/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fs http://127.0.0.1:8090/api/health >/dev/null

compose exec -T -e ADMIN_PASSWORD=e2e-password-123 api python -m app.cli create-user --name e2e
status=0
npm --prefix apps/web run e2e || status=$?
compose down -v
exit $status
