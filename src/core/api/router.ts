// Versioned HTTP API shared by the hosted server (GitHub) and the local companion (Git CLI).
// Every route delegates to a registry command, so validation, capability checks and the
// destructive-action policy are identical for the UI, agents, the CLI and MCP.

import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { AppError, HTTP_STATUS, type RepositoryEvent } from "../types.ts";
import type { RepositoryResolver } from "../port.ts";
import { describeCommand, executeCommand, type CommandContext, type CommandRegistry, type ExecuteResponse } from "../commands/registry.ts";
import { formatCursor } from "../types.ts";
import type { EventHub } from "../sync/hub.ts";
import { openApiDocument } from "./openapi.ts";

export interface ApiHostOptions {
  registry: CommandRegistry;
  /** Per-request resolver: binds the caller's session (GitHub token) or the companion. */
  resolver: (c: Context) => Promise<RepositoryResolver> | RepositoryResolver;
  appOrigin: (c: Context) => string;
  hub: EventHub;
  /** Called before a repository's event stream starts; verifies the caller may read it. */
  authorizeEvents?: (c: Context, repoKey: string) => Promise<void>;
  /** Called when a client subscribes, so the host can start watchers / pollers. Returns a release fn. */
  onSubscribe?: (repoKey: string, c: Context) => (() => void) | void;
  heartbeatMs?: number;
}

export function sendResult(c: Context, r: ExecuteResponse, extraHeaders?: Record<string, string>) {
  if (r.ok) {
    for (const [k, v] of Object.entries(extraHeaders ?? {})) c.header(k, v);
    return c.json(r.result as object);
  }
  const status = HTTP_STATUS[r.error.code] ?? 500;
  return c.json({ error: r.error }, status as 400);
}

function boolParam(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === "1" || v === "true";
}

export function createApi(opts: ApiHostOptions): Hono {
  const api = new Hono();

  const ctxFor = async (c: Context): Promise<CommandContext> => ({
    resolver: await opts.resolver(c),
    appOrigin: opts.appOrigin(c),
    actor: c.req.header("x-client") === "ui" ? "ui" : c.req.header("x-client") === "cli" ? "cli" : c.req.header("x-client") === "mcp" ? "mcp" : "api",
    signal: c.req.raw.signal,
  });

  const run = async (c: Context, command: string, args: Record<string, unknown>, confirm?: string) =>
    executeCommand(opts.registry, await ctxFor(c), { command, args, confirm });

  api.onError((err, c) => {
    const e = AppError.from(err);
    return c.json({ error: e.toJSON() }, (HTTP_STATUS[e.code] ?? 500) as 400);
  });

  api.get("/openapi.json", (c) => c.json(openApiDocument(opts.registry)));

  api.get("/commands", (c) => c.json({ commands: opts.registry.list().map(describeCommand) }));

  api.post("/commands/execute", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { command?: string; args?: unknown; confirm?: string } | null;
    if (!body || typeof body.command !== "string") throw new AppError("BAD_REQUEST", 'Body must be {"command": string, "args"?: object, "confirm"?: string}');
    const r = await executeCommand(opts.registry, await ctxFor(c), { command: body.command, args: body.args, confirm: body.confirm });
    if (r.ok) return c.json(r);
    return c.json(r, (HTTP_STATUS[r.error.code] ?? 500) as 400);
  });

  api.get("/repositories", async (c) =>
    sendResult(c, await run(c, "repo.list", { query: c.req.query("query") || undefined, limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined })),
  );

  const id = (c: Context) => c.req.param("id")!;

  api.get("/repositories/:id", async (c) => sendResult(c, await run(c, "repo.info", { repo: id(c) })));
  api.get("/repositories/:id/capabilities", async (c) => sendResult(c, await run(c, "repo.capabilities", { repo: id(c) })));

  api.get("/repositories/:id/refs", async (c) => {
    const r = await run(c, "repo.refs", { repo: id(c) });
    if (r.ok) {
      const etag = `"${(r.result as { version: string }).version}"`;
      if (c.req.header("if-none-match") === etag) return c.body(null, 304, { ETag: etag });
      c.header("ETag", etag);
      c.header("Cache-Control", "private, no-cache");
    }
    return sendResult(c, r);
  });

  api.get("/repositories/:id/commits", async (c) => {
    const q = c.req.query();
    const refs = c.req.queries("ref") ?? (q.refs ? q.refs.split(",") : undefined);
    return sendResult(
      c,
      await run(c, "repo.history", {
        repo: id(c),
        refs: refs?.filter(Boolean),
        includeRemotes: boolParam(q.remotes),
        includeTags: boolParam(q.tags),
        includeStashes: boolParam(q.stashes),
        firstParent: boolParam(q["first-parent"]),
        order: q.order,
        cursor: q.cursor || null,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    );
  });

  api.get("/repositories/:id/commits/:hash", async (c) => {
    const hash = c.req.param("hash")!;
    // Full object ids are immutable: let browsers and proxies cache them for a long time.
    const immutable = /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(hash) ? { "Cache-Control": "private, max-age=31536000, immutable" } : undefined;
    return sendResult(c, await run(c, "repo.commit", { repo: id(c), hash }), immutable);
  });

  api.get("/repositories/:id/compare", async (c) =>
    sendResult(c, await run(c, "repo.compare", { repo: id(c), base: c.req.query("base"), head: c.req.query("head"), path: c.req.query("path") || undefined })),
  );

  api.get("/repositories/:id/diff", async (c) => {
    const q = c.req.query();
    return sendResult(
      c,
      await run(c, "repo.diff", {
        repo: id(c),
        hash: q.hash || undefined,
        base: q.base || undefined,
        head: q.head || undefined,
        working: q.working || undefined,
        path: q.path || undefined,
        context: q.context ? Number(q.context) : undefined,
      }),
    );
  });

  api.get("/repositories/:id/search", async (c) =>
    sendResult(c, await run(c, "repo.search", { repo: id(c), text: c.req.query("text") ?? c.req.query("q"), limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined })),
  );
  api.get("/repositories/:id/file-history", async (c) =>
    sendResult(c, await run(c, "repo.fileHistory", { repo: id(c), path: c.req.query("path"), cursor: c.req.query("cursor") || null, limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined })),
  );
  api.get("/repositories/:id/blame", async (c) => sendResult(c, await run(c, "repo.blame", { repo: id(c), path: c.req.query("path"), rev: c.req.query("rev") || undefined })));
  api.get("/repositories/:id/file", async (c) => sendResult(c, await run(c, "repo.file", { repo: id(c), path: c.req.query("path"), rev: c.req.query("rev") || "HEAD" })));
  api.get("/repositories/:id/status", async (c) => sendResult(c, await run(c, "repo.status", { repo: id(c) })));
  api.get("/repositories/:id/worktrees", async (c) => sendResult(c, await run(c, "repo.worktrees", { repo: id(c) })));
  api.get("/repositories/:id/remotes", async (c) => sendResult(c, await run(c, "repo.remotes", { repo: id(c) })));
  api.get("/repositories/:id/conflict", async (c) => sendResult(c, await run(c, "repo.conflict", { repo: id(c), path: c.req.query("path") })));

  /** POST /repositories/:id/mutations { mutation: GitMutation, precondition?, confirm? } */
  api.post("/repositories/:id/mutations", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { mutation?: { op?: string }; precondition?: unknown; confirm?: string } | null;
    if (!body?.mutation?.op) throw new AppError("BAD_REQUEST", 'Body must be {"mutation": {"op": ...}, "precondition"?, "confirm"?}');
    const { op, ...args } = body.mutation;
    const r = await run(c, `git.${op}`, { ...args, repo: id(c), precondition: body.precondition }, body.confirm);
    return sendResult(c, r);
  });

  /** Server-Sent Events: repository-scoped change stream with resumable cursors. */
  api.get("/repositories/:id/events", async (c) => {
    const key = id(c);
    if (opts.authorizeEvents) await opts.authorizeEvents(c, key);
    else await (await opts.resolver(c)).resolve(key); // at least prove the caller can open it
    const cursor = c.req.header("last-event-id") ?? c.req.query("cursor") ?? null;
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      type Frame = { id: string; event: string; data: string };
      const queue: Frame[] = [];
      let wake: (() => void) | null = null;
      const push = (s: Frame) => {
        queue.push(s);
        wake?.();
      };
      const unsub = opts.hub.subscribe(
        key,
        (env) => push({ id: formatCursor(env.epoch, env.seq), event: env.event.type, data: JSON.stringify(env) }),
        cursor,
      );
      const release = opts.onSubscribe?.(key, c);
      // Hello frame tells the client the current cursor/epoch even when nothing happened yet.
      const hello: RepositoryEvent = { type: "sync.ok", repositoryId: key, at: Date.now() };
      await stream.writeSSE({ id: opts.hub.cursor(), event: "hello", data: JSON.stringify({ epoch: opts.hub.epoch, seq: 0, at: Date.now(), event: hello }) });
      const hb = opts.heartbeatMs ?? 15_000;
      let alive = true;
      stream.onAbort(() => {
        alive = false;
        wake?.();
      });
      try {
        while (alive) {
          while (queue.length && alive) {
            await stream.writeSSE(queue.shift()!);
          }
          await new Promise<void>((res) => {
            wake = res;
            setTimeout(res, hb);
          });
          wake = null;
          if (alive && !queue.length) await stream.write(": ping\n\n");
        }
      } finally {
        unsub();
        release?.();
      }
    });
  });

  return api;
}
