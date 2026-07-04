# syntax=docker/dockerfile:1
#
# Builds the @mando/hub server together with the @mando/web static SPA it
# serves. Build context is the repo root (see deploy/docker-compose.yml:
# `context: ..`) because this is a Bun workspace and `bun install` needs to
# see every workspace package to resolve `workspace:*` deps (e.g. hub's
# @mando/protocol) and to satisfy the frozen lockfile.
#
# Pinned to the exact Bun version this repo develops against
# (see package.json "packageManager": "bun@1.3.14") for reproducible builds.

ARG BUN_VERSION=1.3.14

########################################
# 1. builder -- install deps, build web SPA
########################################
FROM oven/bun:${BUN_VERSION} AS builder
WORKDIR /app

# Copy manifests first so `bun install` is cached unless dependencies change.
COPY package.json bun.lock turbo.json ./
COPY apps/hub/package.json apps/hub/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/opencode-plugin/package.json packages/opencode-plugin/package.json

RUN bun install --frozen-lockfile

# Now bring in the rest of the source and build the web SPA. The hub itself
# is run from source via `bun run`, so no separate build step is needed for
# it -- only its (already installed) dependencies.
COPY . .
RUN bun run build --filter @mando/web

########################################
# 2. prod-deps -- separate, production-only install for the runtime image.
# Reuses the same manifests as `builder` but skips devDependencies
# (typescript, vite, tailwind, turbo, ...) so they never reach the runtime
# image -- this alone cuts node_modules from ~362M to ~168M.
########################################
FROM oven/bun:${BUN_VERSION} AS prod-deps
WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY apps/hub/package.json apps/hub/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/opencode-plugin/package.json packages/opencode-plugin/package.json

RUN bun install --frozen-lockfile --production

########################################
# 3. runtime -- minimal image, hub + built web assets + prod deps only
########################################
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    MANDO_WEB_DIR=/app/apps/web/dist

# Root package.json carries the "workspaces" field bun's runtime resolver
# uses to resolve the hub's `workspace:*` import of @mando/protocol.
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/packages/protocol ./packages/protocol
COPY --from=builder /app/apps/hub ./apps/hub
COPY --from=builder /app/apps/web/dist ./apps/web/dist

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(Bun.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# oven/bun images ship a non-root `bun` user (uid 1000) -- run as that.
USER bun

CMD ["bun", "run", "apps/hub/src/index.ts"]
