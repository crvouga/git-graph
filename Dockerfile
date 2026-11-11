# syntax=docker/dockerfile:1
# Lanes hosted server: builds the SPA + bundled Node server, runs it stateless as a non-root user.
# No build args or secrets; all configuration comes from env at runtime (see docs/deploy.md).
#   docker build -t lanes .
#   docker run --rm -p 8787:8787 -e APP_ORIGIN=http://localhost:8787 -e SESSION_SECRET="$(openssl rand -base64 48)" lanes

FROM node:26-bookworm-slim AS build
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# zero-cache (Zero's sync server, run by the server as a child process) with its native SQLite.
# Pinned to the @rocicorp/zero version the app is built with.
FROM node:26-bookworm-slim AS zero
WORKDIR /zero
COPY package.json /tmp/package.json
RUN ZERO_VERSION="$(node -p "require('/tmp/package.json').dependencies['@rocicorp/zero']")" \
 && npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund "@rocicorp/zero@${ZERO_VERSION}"

FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/dist/web \
    ZERO_CACHE_BIN=/zero/node_modules/@rocicorp/zero/out/zero/src/cli.js \
    ZERO_REPLICA_FILE=/tmp/lanes-zero/replica.db
WORKDIR /app
# The server is a single self-contained bundle. Durable state is only in PostgreSQL: sessions are
# sealed cookies, and zero-cache's SQLite replica in /tmp is a disposable cache it rebuilds from
# PostgreSQL on start (mount a volume there to make restarts faster).
COPY --from=zero /zero /zero
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/dist/web ./dist/web
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "dist/server/server.mjs"]
