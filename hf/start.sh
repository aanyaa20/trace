#!/usr/bin/env bash
# Every process of trace in one container, for a Hugging Face Space (which
# runs exactly one). If any of them exits, the container exits and the Space
# restarts it, rather than serving half an application.
set -uo pipefail

mkdir -p "$UPLOAD_DIR"

redis-server --port 6379 --bind 127.0.0.1 --save "" --appendonly no --daemonize yes

(cd /srv/ml && exec uvicorn app.main:app --host 127.0.0.1 --port 8000 --log-level warning) &

(cd /srv/node/apps/api && exec node dist/index.js) &

# The worker must not start before the api has applied migrations.
for _ in $(seq 1 120); do
  curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break
  sleep 1
done
(cd /srv/node/apps/api && RUN_MIGRATIONS_ON_BOOT=false exec node dist/queue/worker.js) &

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &

wait -n
echo "a trace process exited; stopping so the Space restarts" >&2
exit 1
