# syntax=docker/dockerfile:1
#
# trace "lite" for a free Render web service (512 MB, 0.1 CPU, no disk).
# Every model is a hosted API (ML_MODE=lite): Gemini embeddings and vision,
# Groq Whisper and vision. Postgres is Neon, vectors are Qdrant Cloud, and
# uploaded files persist in a private Hugging Face dataset, because the
# instance's disk is wiped whenever it restarts or wakes from sleep.
#
# Built by Render from render.yaml; locally:
#   docker build -f render/Dockerfile -t trace-render .

FROM node:22.23.2-bookworm-slim AS node-build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages/contracts packages/contracts
COPY apps/api apps/api
COPY apps/web apps/web
ENV VITE_API_URL=/api
RUN pnpm --filter @trace/contracts build \
 && pnpm --filter @trace/api build \
 && pnpm --filter @trace/web build \
 && pnpm --filter @trace/api --prod deploy --legacy /out/api

FROM python:3.11.10-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl redis-server \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node-build /usr/local/bin/node /usr/local/bin/node
COPY --from=caddy:2.10-alpine /usr/bin/caddy /usr/bin/caddy
# The official binary carries a file capability (to bind ports below 1024).
# Hosts that run containers with no-new-privileges, Render among them,
# refuse to execute such a file at all: "Operation not permitted". Caddy
# listens on a high port here and needs none, so the capability is removed.
RUN apt-get update && apt-get install -y --no-install-recommends libcap2-bin \
 && setcap -r /usr/bin/caddy \
 && apt-get purge -y libcap2-bin && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
COPY services/ml/requirements-lite.txt /srv/ml/requirements-lite.txt
RUN pip install -r /srv/ml/requirements-lite.txt
COPY services/ml/app /srv/ml/app

# Production dependencies only: the dev toolchain would not fit the memory
# budget's disk image any better than its heap.
COPY --from=node-build /out/api /srv/node/apps/api
COPY --from=node-build /app/apps/api/drizzle /srv/node/apps/api/drizzle
COPY --from=node-build /app/apps/web/dist /srv/web
COPY render/Caddyfile /etc/caddy/Caddyfile
COPY render/start.sh /srv/start.sh

ENV NODE_ENV=production \
    ML_MODE=lite \
    API_HOST=127.0.0.1 API_PORT=8080 \
    REDIS_URL=redis://127.0.0.1:6379 \
    ML_SERVICE_URL=http://127.0.0.1:8000 \
    UPLOAD_DIR=/data/uploads \
    QDRANT_COLLECTION=chunks \
    DENSE_DIM=768 EMBEDDING_DIM=768 \
    COOKIE_SECURE=true \
    BLOB_STORE=hf \
    RUN_MIGRATIONS_ON_BOOT=true \
    RUN_WORKER_IN_PROCESS=true \
    INGEST_CONCURRENCY=1 \
    RERANK_ENABLED=false \
    CITATION_MIN_SUPPORT=0 \
    VISUAL_CHECK_MAX_IMAGES=1 \
    VISION_PROVIDERS=gemini,groq \
    ML_THREADPOOL_WORKERS=1 OMP_NUM_THREADS=1 \
    MALLOC_ARENA_MAX=2 \
    MAX_UPLOAD_BYTES=26214400 \
    LLM_PROVIDER=groq \
    WEB_SEARCH_PROVIDER=none \
    XDG_DATA_HOME=/tmp/caddy XDG_CONFIG_HOME=/tmp/caddy

EXPOSE 10000
CMD ["/srv/start.sh"]
