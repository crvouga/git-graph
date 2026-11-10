# syntax=docker/dockerfile:1
# Lanes hosted server: builds the SPA + bundled Node server, runs it as a non-root user.
#   docker build -t lanes .
#   docker run -p 8787:8787 --env-file .env -v lanes-data:/data lanes

FROM node:24-slim AS build
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/dist/web \
    DATA_DIR=/data
WORKDIR /app
# The server is a single self-contained bundle: no node_modules at runtime.
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --from=build --chown=node:node /app/dist/web ./dist/web
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "dist/server/server.mjs"]
