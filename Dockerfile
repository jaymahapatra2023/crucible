# syntax=docker/dockerfile:1.7
# Crucible — two images from one build (docs/DEPLOYMENT_AWS.md).
#
#   docker build --target api -t crucible-api .
#   docker build --target web -t crucible-web .
#
# The build runs entirely inside the image from source: the same `pnpm build` CI runs, pinned
# to the pnpm the lockfile was written with. Nothing built on a laptop is copied in.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=9.15.9

# ── deps + build ────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# Manifests first, so dependency installation is cached until a manifest changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/prober/package.json packages/prober/
COPY packages/rubric/package.json packages/rubric/
COPY packages/scanner/package.json packages/scanner/
COPY packages/scoring/package.json packages/scoring/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
COPY db db
# Packages, then the API, then the web app — the order `pnpm build` at the root uses.
RUN pnpm -r --filter "./packages/**" build \
 && pnpm --filter @crucible/api build \
 && pnpm --filter @crucible/web build

# ── api runtime ─────────────────────────────────────────────────────────────────────────────
# Keeps the workspace LAYOUT (pnpm-workspace.yaml at /app, db/migrations beside it): the API
# locates migrations and the seed directory by walking up to that marker.
FROM ${NODE_IMAGE} AS api
ARG PNPM_VERSION
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# git: submissions are cloned. tar: the prober ships a build context over stdin. The docker CLI
# talks to the HOST daemon through a mounted socket; no daemon runs in this image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tar ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/.npmrc* ./
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/packages/contracts/package.json packages/contracts/
COPY --from=build /app/packages/prober/package.json packages/prober/
COPY --from=build /app/packages/rubric/package.json packages/rubric/
COPY --from=build /app/packages/scanner/package.json packages/scanner/
COPY --from=build /app/packages/scoring/package.json packages/scoring/
# Production dependencies only, for the API and the packages it links.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts --filter @crucible/api...

COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/prober/dist packages/prober/dist
COPY --from=build /app/packages/rubric/dist packages/rubric/dist
COPY --from=build /app/packages/scanner/dist packages/scanner/dist
COPY --from=build /app/packages/scoring/dist packages/scoring/dist
COPY --from=build /app/db db

# Where clones, scans and brief artifacts live. Both are volumes in compose (see there).
ENV HOST=0.0.0.0 PORT=3101 WORKSPACE_ROOT=/var/lib/crucible TMPDIR=/var/tmp/crucible
RUN mkdir -p /var/lib/crucible /var/tmp/crucible
EXPOSE 3101
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3101)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# tini reaps the child processes git and docker leave behind; the API handles SIGTERM itself.
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/api/dist/index.js"]

# ── web: static files behind Caddy, which also terminates TLS and proxies the API ───────────
FROM caddy:2-alpine AS web
COPY deploy/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
