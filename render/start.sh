#!/usr/bin/env bash
# trace on one 512 MB Render instance: Redis, the lite ml service, one Node
# process holding both the api and the ingestion worker, and Caddy on $PORT.
# If any exits, the container exits and Render restarts it.
set -uo pipefail
mkdir -p "$UPLOAD_DIR"

redis-server --port 6379 --bind 127.0.0.1 --save "" --appendonly no \
  --maxmemory 32mb --maxmemory-policy noeviction --daemonize yes

(cd /srv/ml && exec uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1 --log-level warning) &

# A capped heap: the V8 default would size itself to the host, not to the
# instance, and be killed for it.
(cd /srv/node/apps/api && exec node --max-old-space-size=224 dist/index.js) &

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &

wait -n
echo "a trace process exited; stopping so Render restarts the instance" >&2
exit 1
