// Entry point: `node src/server/main.ts` (dev) or `node dist/server/server.mjs` (bundled).
// Paths come from env/cwd, never import.meta, so the bundle works from any location.

import { serve } from "@hono/node-server";
import { createServerApp } from "./app.ts";
import { loadConfig } from "./config.ts";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (e) {
  // Fail fast with a message that names the missing or invalid variable.
  console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: `invalid configuration: ${e instanceof Error ? e.message : String(e)}` }));
  process.exit(1);
}
const server = createServerApp(config);

const warn = (msg: string) => console.log(JSON.stringify({ t: new Date().toISOString(), level: "warn", msg }));
if (!config.oidc || !config.databaseUrl) warn("OIDC_ISSUER / DATABASE_URL not set: sign-in disabled, public repositories only");
else if (!config.githubClientId || !config.githubClientSecret) warn("GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not set: connecting GitHub disabled");
if (!config.webhookSecret) warn("GITHUB_WEBHOOK_SECRET not set: webhooks disabled, real-time sync relies on polling");
if (!config.production && !process.env.SESSION_SECRET) warn("SESSION_SECRET not set: using an ephemeral secret (sessions do not survive restarts)");

if (!config.zero) warn("DATABASE_URL not set: Zero sync is off and the web client cannot show repositories");

const http = serve({ fetch: server.app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", msg: "lanes server listening", port: info.port, origin: config.appOrigin, staticDir: config.staticDir, epoch: server.hub.epoch }));
  // zero-cache needs the migrated schema (its publication) before it starts replicating.
  void server.ready().then(() => server.startZero(info.port));
});
http.on("upgrade", (req, socket, head) => {
  if (!server.upgrade(req, socket, head)) socket.destroy();
});

let stopping = false;
const shutdown = (sig: string) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", msg: "shutting down", signal: sig }));
  void server.close().finally(() => {
    http.close(() => process.exit(0));
    // SSE streams keep connections open; don't wait for them forever.
    setTimeout(() => process.exit(0), 5_000).unref();
    (http as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
