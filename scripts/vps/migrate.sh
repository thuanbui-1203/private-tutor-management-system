#!/usr/bin/env bash
# Apply Prisma migrations of every service on the VPS (docs/06-trien-khai-vps.md).
# PostgreSQL publishes no port in production, so migrations run inside the Docker network
# from each service's `build` stage image (it has the Prisma CLI and prisma/migrations).
# Run from the repo root after the stack is up:  bash scripts/vps/migrate.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
# Read one KEY=value from .env without sourcing it (values may hold spaces or quotes).
envval() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

NETWORK="tms_tms-net"
declare -A URLS=(
  [identity-service]="$(envval IDENTITY_DB_URL)"
  [student-service]="$(envval STUDENT_DB_URL)"
  [class-service]="$(envval CLASS_DB_URL)"
  [schedule-service]="$(envval SCHEDULE_DB_URL)"
  [billing-service]="$(envval BILLING_DB_URL)"
)

for svc in identity-service student-service class-service schedule-service billing-service; do
  echo "== $svc"
  docker build -q --target build -f "backend/$svc/Dockerfile" -t "tms-$svc-build" . >/dev/null
  docker run --rm --network "$NETWORK" -e DATABASE_URL="${URLS[$svc]}" "tms-$svc-build" \
    pnpm --filter "@tms/$svc" migrate:deploy
done
echo "All migrations applied."
