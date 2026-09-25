# syntax=docker/dockerfile:1

FROM node:22.23.2-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# argon2 ships prebuilds for common platforms but falls back to node-gyp,
# which needs a toolchain; python3 and make are cheap insurance.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
# Every workspace member the lockfile knows about must be present, or
# --frozen-lockfile rejects the tree as outdated. apps/web contributes no
# dependencies to this image; only its manifest is needed.
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --filter @trace/api... --frozen-lockfile

FROM deps AS dev
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @trace/contracts build
EXPOSE 8080
CMD ["pnpm", "--filter", "@trace/api", "dev"]

FROM deps AS build
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @trace/contracts build && pnpm --filter @trace/api build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/contracts packages/contracts
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/drizzle apps/api/drizzle
COPY --from=build /app/apps/api/package.json apps/api/
WORKDIR /app/apps/api
EXPOSE 8080
CMD ["node", "dist/index.js"]
