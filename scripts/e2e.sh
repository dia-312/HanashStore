#!/usr/bin/env bash
# Runs the WebKit browser tests against a fresh throwaway stack (docker-compose.e2e.yml).
# Usage:
#   bash scripts/e2e.sh        the whole journey (builds the web app first)
#   bash scripts/e2e.sh seed   only login and the first sync of the large dataset (400 products,
#                              2,000 variants; needs apps/api/seed-data from scripts/seed_large.py)
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

args=()
if [ "${1:-}" = "seed" ]; then
  MSYS_NO_PATHCONV=1 compose exec -T api python -m scripts.load_seed /seed
  export E2E_SEED=1
  args=(--grep "login and PIN|first sync")
fi

status=0
npm --prefix apps/web run e2e -- "${args[@]}" || status=$?
compose down -v
exit $status
