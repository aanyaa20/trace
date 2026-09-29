# syntax=docker/dockerfile:1
#
# trace as one image for a Hugging Face Space (Docker SDK, free CPU tier:
# 2 vCPU, 16 GB). The Space runs a single container, so everything that is a
# separate Compose service elsewhere runs here as a process under
# hf/start.sh: Redis, the ml service, the api, the ingestion worker, and
# Caddy on the one public port. Postgres (Neon) and Qdrant (Qdrant Cloud) are
# hosted, and uploaded files persist in a private dataset (BLOB_STORE=hf),
# because the Space's own disk is rebuilt at every restart.
#
# Built from the repository root: deploy/deploy-hf.sh copies this file there.

# --- the TypeScript side: contracts, api, worker, web -----------------------
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
 && pnpm --filter @trace/web build

# --- the runtime: Python for the ml service, plus node, redis and caddy -----
FROM python:3.11.10-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg libgl1 libglib2.0-0 ca-certificates curl redis-server \
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

# A Space runs the container as uid 1000; everything it writes must be its.
RUN useradd -m -u 1000 user \
 && mkdir -p /data/uploads /models /srv \
 && chown -R user:user /data /models /srv

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/hf FASTEMBED_CACHE_PATH=/models/fastembed TORCH_HOME=/models/torch \
    OCR_MODEL_DIR=/models/ocr UPLOAD_DIR=/data/uploads \
    OMP_NUM_THREADS=2 ML_THREADPOOL_WORKERS=2

RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.14.0 torchvision==0.29.0
COPY services/ml/requirements.txt /srv/ml/requirements.txt
RUN pip install -r /srv/ml/requirements.txt
COPY --chown=user:user services/ml/app /srv/ml/app

USER user
# Weights into the image, so a restart does not download them again.
RUN cd /srv/ml && python -m app.prefetch

COPY --from=node-build --chown=user:user /app/node_modules /srv/node/node_modules
COPY --from=node-build --chown=user:user /app/packages/contracts /srv/node/packages/contracts
COPY --from=node-build --chown=user:user /app/apps/api/node_modules /srv/node/apps/api/node_modules
COPY --from=node-build --chown=user:user /app/apps/api/dist /srv/node/apps/api/dist
COPY --from=node-build --chown=user:user /app/apps/api/drizzle /srv/node/apps/api/drizzle
COPY --from=node-build --chown=user:user /app/apps/api/package.json /srv/node/apps/api/package.json
COPY --from=node-build --chown=user:user /app/apps/web/dist /srv/web
COPY --chown=user:user hf/Caddyfile /etc/caddy/Caddyfile
COPY --chown=user:user hf/start.sh /srv/start.sh

# Everything that is not a secret. Secrets (keys, database URL, JWT secret)
# are set as Space secrets and arrive as environment variables.
ENV NODE_ENV=production \
    API_HOST=127.0.0.1 API_PORT=8080 \
    REDIS_URL=redis://127.0.0.1:6379 \
    ML_SERVICE_URL=http://127.0.0.1:8000 \
    QDRANT_COLLECTION=chunks \
    COOKIE_SECURE=true \
    BLOB_STORE=hf \
    RUN_MIGRATIONS_ON_BOOT=true \
    LLM_PROVIDER=groq \
    INGEST_CONCURRENCY=1 \
    XDG_DATA_HOME=/tmp/caddy XDG_CONFIG_HOME=/tmp/caddy

EXPOSE 7860
CMD ["/srv/start.sh"]
