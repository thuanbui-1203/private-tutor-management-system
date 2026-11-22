#!/usr/bin/env bash
# Dump every service database to ~/backups/<date>/ and keep the last 7 days.
# Cron (as deploy), daily at 02:00:
#   0 2 * * * bash /home/deploy/tms/scripts/vps/backup-db.sh >> /home/deploy/backups/backup.log 2>&1
# Restore one database:
#   docker compose exec -T postgres pg_restore -U tms -d <db> --clean --if-exists < <file>.dump
set -euo pipefail
cd "$(dirname "$0")/../.."
# Read one KEY=value from .env without sourcing it (values may hold spaces or quotes).
envval() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

DEST="$HOME/backups/$(date +%F)"
mkdir -p "$DEST"
for db in identity_db student_db class_db schedule_db billing_db; do
  docker compose exec -T postgres pg_dump -U "$(envval POSTGRES_USER)" -Fc "$db" >"$DEST/$db.dump"
done
find "$HOME/backups" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +
echo "$(date -Is) backup ok: $DEST"
