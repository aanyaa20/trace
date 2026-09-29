#!/usr/bin/env bash
# Nightly backup of everything that cannot be rebuilt: the database, the
# uploaded files, and the vector index. Seven days are kept in ~/backups.
#
# Restore, in outline: stop the stack; `docker compose ... run --rm postgres
# psql` the .sql back in; untar uploads into the uploads volume; upload the
# Qdrant snapshot through its /snapshots/upload endpoint.
set -euo pipefail
cd "${TRACE_DIR:-$HOME/trace}"
BACKUPS="${BACKUP_DIR:-$HOME/backups}"
compose() { docker compose -f docker-compose.yml -f docker-compose.prod.yml "$@"; }

stamp=$(date +%Y-%m-%d)
dest="$BACKUPS/$stamp"
mkdir -p "$dest"

compose exec -T postgres pg_dump -U "${POSTGRES_USER:-trace}" "${POSTGRES_DB:-trace}" | gzip > "$dest/postgres.sql.gz"

compose exec -T api tar -C /data -czf - uploads > "$dest/uploads.tar.gz"

# Qdrant writes the snapshot inside its container; it is streamed out, then
# deleted there so snapshots do not pile up on the data volume.
name=$(compose exec -T api node -e "
const r = await fetch('http://qdrant:6333/collections/chunks/snapshots', { method: 'POST' });
console.log((await r.json()).result.name);")
compose exec -T api node -e "
const r = await fetch('http://qdrant:6333/collections/chunks/snapshots/$name');
process.stdout.write(Buffer.from(await r.arrayBuffer()));" > "$dest/qdrant-chunks.snapshot"
compose exec -T api node -e "await fetch('http://qdrant:6333/collections/chunks/snapshots/$name', { method: 'DELETE' });"

find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +
echo "$(date "+%Y-%m-%dT%H:%M:%S") backup written to $dest ($(du -sh "$dest" | cut -f1))"
