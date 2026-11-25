#!/usr/bin/env bash
# Maintenance mode on the VPS (docs/06-trien-khai-vps.md §6.2). Run in the repo root (~/tms):
#   bash scripts/vps/maintenance.sh on      # public site -> 503 page; app containers stopped
#   bash scripts/vps/maintenance.sh off     # back to the app
#   bash scripts/vps/maintenance.sh status
#
# Databases, RabbitMQ and Redis keep running (the nightly backup still works). No data is removed.
set -euo pipefail
cd "$(dirname "$0")/../.."

CONFIG=infra/cloudflared/config.yml
SAVED=infra/cloudflared/config.live.yml
APPS='frontend api-gateway identity-service student-service class-service schedule-service billing-service audit-service'
PAGE=tms-maintenance
names() { for a in $APPS; do echo "tms-$a-1"; done; }

case "${1:-status}" in
  on)
    docker rm -f "$PAGE" >/dev/null 2>&1 || true
    # Reuses the frontend image only for its Node.js runtime: nothing to pull or build.
    docker run -d --name "$PAGE" --network tms_tms-net --restart unless-stopped --read-only \
      --cap-drop ALL --security-opt no-new-privileges --memory 96m \
      -v "$PWD/infra/maintenance/server.mjs:/srv/server.mjs:ro" \
      --entrypoint node tms-frontend:latest /srv/server.mjs >/dev/null
    # Never overwrite the saved live config with a maintenance one.
    [ -f "$SAVED" ] || cp -p "$CONFIG" "$SAVED"
    sed -E "s#service: http://(frontend:5173|api-gateway:8080)#service: http://$PAGE:8090#" "$SAVED" > "$CONFIG.new"
    cat "$CONFIG.new" > "$CONFIG" && rm -f "$CONFIG.new" # keep owner and mode
    docker restart tms-cloudflared-1 >/dev/null
    docker stop $(names) >/dev/null
    echo 'maintenance: ON'
    ;;
  off)
    [ -f "$SAVED" ] || { echo "no $SAVED: not in maintenance mode"; exit 1; }
    docker start $(names) >/dev/null
    for i in $(seq 1 60); do
      [ "$(docker inspect -f '{{.State.Health.Status}}' tms-api-gateway-1)" = healthy ] &&
        [ "$(docker inspect -f '{{.State.Health.Status}}' tms-frontend-1)" = healthy ] && break
      sleep 5
    done
    cat "$SAVED" > "$CONFIG" && rm -f "$SAVED"
    docker restart tms-cloudflared-1 >/dev/null
    docker rm -f "$PAGE" >/dev/null
    echo 'maintenance: OFF'
    ;;
  status)
    [ -f "$SAVED" ] && echo 'maintenance: ON' || echo 'maintenance: OFF'
    docker ps -a --format '{{.Names}}: {{.Status}}'
    ;;
  *) echo "usage: $0 on|off|status" >&2; exit 2 ;;
esac
