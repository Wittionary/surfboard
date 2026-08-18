# syntax=docker/dockerfile:1.7

# Multi-stage image for Surfboard. Pinned to the same Bun the README requires.
# Stages:
#   deps    — install production + dev deps from a frozen lockfile.
#   build   — bundle the frontend (dist/frontend) using the deps cache.
#   runtime — minimal layer: production deps + built frontend + server source.

ARG BUN_VERSION=1.3.13
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:${BUN_VERSION}-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN bun run scripts/build-frontend.ts

FROM oven/bun:${BUN_VERSION}-slim AS runtime

ARG UID=1000
ARG GID=1000
# The base image ships a `bun` user and group at 1000. Provide a `surfboard`
# identity at the requested uid/gid so bind-mounted YAML stays writable by the
# host user: rename the incumbent when the id collides, create it otherwise.
RUN set -eux; \
  if getent group "${GID}" >/dev/null; then \
    groupmod -n surfboard "$(getent group "${GID}" | cut -d: -f1)"; \
  else \
    groupadd --gid "${GID}" surfboard; \
  fi; \
  if getent passwd "${UID}" >/dev/null; then \
    usermod -l surfboard -g "${GID}" "$(getent passwd "${UID}" | cut -d: -f1)"; \
  else \
    useradd --uid "${UID}" --gid "${GID}" --create-home --shell /bin/sh surfboard; \
  fi

WORKDIR /app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN chown -R surfboard:surfboard /app

USER surfboard

ENV NODE_ENV=production \
    SURFBOARD_HOST=0.0.0.0 \
    SURFBOARD_PORT=3000 \
    ADO_WORKSPACE_DIR=/workspace \
    ADO_TEMPLATE_DIR=/workspace/templates \
    SURFBOARD_WATCH_POLLING=1

VOLUME ["/workspace"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun run scripts/healthcheck.ts

CMD ["bun", "run", "src/server/index.ts"]
