#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
backup="backups/simpledrive-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
tmp="${backup}.tmp"
trap 'rm -f "$tmp"' EXIT HUP INT TERM
# Separate commands so a pg_dump failure cannot be hidden by gzip's exit status.
docker compose exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$tmp"
gzip -c "$tmp" > "$backup"
printf 'Backup saved: %s\n' "$backup"
