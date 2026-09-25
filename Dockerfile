# BuildKit (bundled with Docker Desktop) is required for --mount=type=cache; no syntax directive so nothing is pulled from Docker Hub.
# ---------------------------------------------------------------------------
# Outreach Engine – multi-stage image
#   deps    : install every workspace dependency (cached layer)
#   build   : compile shared + api + web
#   runtime : production node_modules + build output only, non-root user
# The same image runs the API (default CMD), the worker and the migration task.
# ---------------------------------------------------------------------------
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:20-bookworm-slim

# ---------- deps ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY infra/cdk/package.json infra/cdk/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev --workspace packages/shared --workspace apps/api --workspace apps/web

# ---------- build ----------
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build -w packages/shared \
 && npm run build -w apps/api \
 && npm run build -w apps/web

# ---------- prod deps ----------
FROM deps AS prod-deps
WORKDIR /app
RUN --mount=type=cache,target=/root/.npm \
    npm prune --omit=dev --workspace packages/shared --workspace apps/api \
 && rm -rf apps/web/node_modules infra

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    LOG_PRETTY=false \
    STORAGE_LOCAL_DIR=/data/storage
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 mailapp \
 && useradd --system --uid 1001 --gid mailapp --home /app --shell /usr/sbin/nologin mailapp \
 && mkdir -p /data/storage && chown -R mailapp:mailapp /data

COPY --from=prod-deps --chown=mailapp:mailapp /app/package.json ./package.json
COPY --from=prod-deps --chown=mailapp:mailapp /app/node_modules ./node_modules
COPY --from=prod-deps --chown=mailapp:mailapp /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=prod-deps --chown=mailapp:mailapp /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=mailapp:mailapp /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=mailapp:mailapp /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=mailapp:mailapp /app/apps/api/drizzle ./apps/api/drizzle
COPY --from=build --chown=mailapp:mailapp /app/apps/web/dist ./apps/web/dist
# npm hoists every dependency to /app/node_modules; the @mailapp/shared workspace link lives there too.

USER mailapp
EXPOSE 4000
VOLUME ["/data/storage"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
# API by default. Worker: ["node","apps/api/dist/worker.js"]  Migrate: ["node","apps/api/dist/db/migrate.js"]
CMD ["node", "apps/api/dist/server.js"]
