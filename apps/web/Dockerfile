# syntax=docker/dockerfile:1

FROM node:22.23.2-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
# See apps/api/Dockerfile: the full set of workspace manifests has to match
# the lockfile even though this image installs only the web subtree.
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN pnpm install --filter @trace/web... --frozen-lockfile

FROM deps AS dev
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter @trace/contracts build
EXPOSE 5173
CMD ["pnpm", "--filter", "@trace/web", "dev"]

# Production: the app built to static files and served by Caddy, which also
# proxies /api to the api container and obtains the HTTPS certificate. The
# api is reached on the same origin, so the session cookie needs no
# cross-site settings and there is no CORS to get wrong.
FROM deps AS build
COPY packages/contracts packages/contracts
COPY apps/web apps/web
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @trace/contracts build && pnpm --filter @trace/web build

FROM caddy:2.10-alpine AS prod
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
EXPOSE 80 443
