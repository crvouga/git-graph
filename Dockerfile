# syntax=docker/dockerfile:1
# Lanes hosted server: builds the SPA + bundled Node server, runs it stateless as a non-root user.
# No build args or secrets; all configuration comes from env at runtime (see docs/deploy.md).
#   docker build -t lanes .
#   docker run --rm -p 8787:8787 -e APP_ORIGIN=http://localhost:8787 -e SESSION_SECRET="$(openssl rand -base64 48)" lanes

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/dist/web
WORKDIR /app
# The server is a single self-contained bundle: no node_modules at runtime. Nothing is written to
# disk: sessions are sealed cookies, everything else is an in-memory cache.
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/dist/web ./dist/web
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "dist/server/server.mjs"]
