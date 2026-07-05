#!/usr/bin/env bash
#
# Dumps the hub's PostgreSQL database via `docker compose exec` and keeps
# the most recent 14 daily backups, deleting anything older.
#
# Intended to run from a daily cron entry on the host running
# deploy/docker-compose.yml, for example:
#   0 3 * * * /opt/mando/backup-postgres.sh
#
# The dump goes through the "postgres" service defined in
# deploy/docker-compose.yml (must already be up), so no Postgres client is
# needed on the host itself -- only Docker Compose.
set -euo pipefail

COMPOSE_FILE="${MANDO_COMPOSE_FILE:-/opt/mando/docker-compose.yml}"
BACKUP_DIR="${MANDO_BACKUP_DIR:-/opt/mando/backups}"
POSTGRES_USER="${MANDO_POSTGRES_USER:-mando}"
POSTGRES_DB="${MANDO_POSTGRES_DB:-mando}"
KEEP=14

mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%d-%H%M%S)"
dest="$BACKUP_DIR/mando-$timestamp.sql.gz"

docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$dest"

echo "Backup written to $dest"

# Keep only the newest $KEEP backups; remove anything older.
mapfile -t backups < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'mando-*.sql.gz' | sort -r)
if [ "${#backups[@]}" -gt "$KEEP" ]; then
  for old in "${backups[@]:$KEEP}"; do
    rm -f -- "$old"
    echo "Removed old backup $old"
  done
fi
