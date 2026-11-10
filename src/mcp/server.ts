// MCP server (stdio) exposing every registry command as a tool.
//
// Local repositories execute IN-PROCESS with CliGitAdapter (no companion needed); the registry, the
// destructive-confirmation flow and the config file (repo ids) are the same as the companion's, so
// keys are interchangeable. GitHub keys are forwarded to a hosted server when LANES_SERVER_URL is set
// (bearer LANES_SERVER_TOKEN if provided), otherwise they fail with UNSUPPORTED.
//
// Extra tools: events_wait (long-poll the event hub with resumable cursors), sync_status, refresh.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { isAbsolute } from "node:path";
import { AppError, formatCursor, parseRepoKey, type EventEnvelope, type SyncStatus } from "../core/types.ts";
import { describeCommand, executeCommand, type AnyCommand } from "../core/commands/registry.ts";
import { HttpApi, HttpResolver, subscribeEvents } from "../core/api/client.ts";
import { createLocalRuntime, type LocalRuntime } from "../companion/runtime.ts";
import { DEFAULT_APP_ORIGIN } from "../companion/config.ts";
import { COMPANION_VERSION } from "../companion/server.ts";

const CONFIRM_NOTE =
  " DESTRUCTIVE: the first call returns error CONFIRMATION_REQUIRED with the exact consequence and a confirmToken. Show the consequence to the user and call again with the same arguments plus `confirm` only after they approve.";

export function toolName(commandId: string): string {
  return commandId.replace(/\./g, "_");
}

type Json = Record<string, unknown>;

function toolFor(cmd: AnyCommand) {
  const d = describeCommand(cmd);
  const schema = { ...(d.argsSchema as Json) };
  delete schema.$schema;
  const props = { ...((schema.properties as Json) ?? {}) };
  if (d.destructive) props.confirm = { type: "string", description: "confirmToken from a previous CONFIRMATION_REQUIRED result, proving the user approved the consequence." };
  if (props.repo) props.repo = { ...(props.repo as Json), description: 'Repository key ("local:<id>", "github:owner:repo") or an absolute local path.' };
  return {
    name: toolName(d.id),
    description: `${d.title}. ${d.description}${d.destructive ? CONFIRM_NOTE : ""}`,
    inputSchema: { ...schema, type: "object" as const, properties: props },
    annotations: { title: d.title, readOnlyHint: d.kind === "query", destructiveHint: d.destructive },
  };
}

const extraTools = [
  {
    name: "events_wait",
    description:
      "Long-poll repository change events (refs.changed, commits.added, status.changed, worktree.changed, resync…). Pass the returned cursor to the next call to resume without gaps; a `resync` event means state must be re-read.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repository key or absolute local path" },
        cursor: { type: "string", description: "Cursor from a previous events_wait call" },
        timeoutMs: { type: "integer", minimum: 0, maximum: 120000, description: "Max wait when no events are pending (default 25000)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "sync_status",
    description: "Synchronization state of a repository: whether changes are being watched, the current refs version and the last error.",
    inputSchema: { type: "object" as const, properties: { repo: { type: "string" } }, required: ["repo"] },
  },
  {
    name: "refresh",
    description: "Re-read a repository now (refs, working tree, worktrees) and publish change events for anything that changed.",
    inputSchema: { type: "object" as const, properties: { repo: { type: "string" } }, required: ["repo"] },
  },
];

export interface McpHostOptions {
  configDir?: string;
  serverUrl?: string;
  serverToken?: string;
  appOrigin?: string;
}

export function createMcpServer(opts: McpHostOptions = {}): { server: Server; runtime: LocalRuntime } {
  const serverUrl = opts.serverUrl ?? process.env.LANES_SERVER_URL;
  const serverToken = opts.serverToken ?? process.env.LANES_SERVER_TOKEN;
  const remoteApi = serverUrl
    ? new HttpApi({ baseUrl: `${serverUrl.replace(/\/+$/, "")}/api/v1`, client: "mcp", headers: (): Record<string, string> => (serverToken ? { authorization: `Bearer ${serverToken}` } : {}) })
    : null;
  const runtime = createLocalRuntime({
    configDir: opts.configDir,
    fallback: remoteApi ? new HttpResolver(remoteApi) : undefined,
    // Agents long-poll in separate calls: keep watching between them so no change is missed.
    watch: { lingerMs: 10 * 60_000 },
  });
  const appOrigin = opts.appOrigin ?? process.env.LANES_APP_ORIGIN ?? DEFAULT_APP_ORIGIN;
  const commandTools = runtime.registry.list().map(toolFor);
  const byTool = new Map(runtime.registry.list().map((c) => [toolName(c.id), c.id]));

  const server = new Server({ name: "lanes", version: COMPANION_VERSION }, { capabilities: { tools: {} } });

  /** Accept an absolute path wherever a repo key is expected. */
  const repoKeyOf = async (repo: unknown): Promise<string> => {
    if (typeof repo !== "string" || !repo) throw new AppError("BAD_REQUEST", 'Argument "repo" is required');
    if (parseRepoKey(repo)) return repo;
    if (isAbsolute(repo)) return (await runtime.local.open(repo)).key;
    throw new AppError("BAD_REQUEST", `"${repo}" is neither a repository key nor an absolute path`);
  };

  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify({ error: AppError.from(e).toJSON() }, null, 2) }], isError: true });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...commandTools, ...extraTools] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = { ...((req.params.arguments as Json | undefined) ?? {}) };
    try {
      if (name === "events_wait") return ok(await eventsWait(await repoKeyOf(args.repo), args.cursor as string | undefined, args.timeoutMs as number | undefined));
      if (name === "sync_status") return ok(await syncStatus(await repoKeyOf(args.repo)));
      if (name === "refresh") return ok(await refresh(await repoKeyOf(args.repo)));
      const id = byTool.get(name);
      if (!id) throw new AppError("NOT_FOUND", `Unknown tool "${name}"`);
      const confirm = typeof args.confirm === "string" ? args.confirm : undefined;
      delete args.confirm;
      if (args.repo !== undefined && id !== "link.build") args.repo = await repoKeyOf(args.repo);
      const r = await executeCommand(runtime.registry, { resolver: runtime.local, appOrigin, actor: "mcp" }, { command: id, args, confirm });
      return r.ok ? ok(r.result) : fail(r.error);
    } catch (e) {
      return fail(e);
    }
  });

  async function eventsWait(key: string, cursor: string | undefined, timeoutMs = 25_000) {
    const timeout = Math.max(0, Math.min(120_000, timeoutMs));
    const events: EventEnvelope[] = [];
    if (!key.startsWith("local:")) {
      if (!remoteApi) throw new AppError("UNSUPPORTED", "GitHub repositories need LANES_SERVER_URL (a hosted Lanes server) for events");
      await new Promise<void>((res) => {
        const sub = subscribeEvents(remoteApi, key, (env) => {
          if ((env.event.type as string) === "sync.ok" && env.seq === 0) return;
          events.push(env);
          setTimeout(() => {
            sub.close();
            res();
          }, 30);
        }, { initialCursor: cursor ?? null });
        setTimeout(() => {
          sub.close();
          res();
        }, timeout);
      });
      const last = events[events.length - 1];
      return { events, cursor: last ? formatCursor(last.epoch, last.seq) : (cursor ?? null) };
    }
    const sub = runtime.acquire(key);
    try {
      await sub.ready;
      await new Promise<void>((res) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsub = runtime.hub.subscribe(
          key,
          (env) => {
            events.push(env);
            if (timer) clearTimeout(timer);
            // Batch bursts: return shortly after the first event.
            timer = setTimeout(done, 40);
          },
          cursor ?? null,
        );
        const overall = setTimeout(done, events.length ? 40 : timeout);
        function done() {
          clearTimeout(overall);
          if (timer) clearTimeout(timer);
          unsub();
          res();
        }
      });
    } finally {
      sub.release();
    }
    const last = events[events.length - 1];
    return { events, cursor: last ? formatCursor(last.epoch, last.seq) : (cursor ?? runtime.hub.cursor()) };
  }

  async function syncStatus(key: string): Promise<SyncStatus> {
    if (!key.startsWith("local:")) throw new AppError("UNSUPPORTED", "sync_status reports local repositories; GitHub sync state lives on the hosted server");
    const adapter = await runtime.local.local(key);
    const w = runtime.watch.info(key);
    const refsVersion = w.refsVersion ?? (await adapter.refsLite()).version;
    return {
      repositoryId: key,
      connection: w.watching ? "live" : "offline",
      lastSuccessAt: w.lastCheckAt,
      ...(w.lastError ? { lastError: w.lastError } : {}),
      refsVersion,
      stale: false,
      pendingOperations: 0,
    };
  }

  async function refresh(key: string) {
    if (!key.startsWith("local:")) throw new AppError("UNSUPPORTED", "refresh applies to local repositories");
    const sub = runtime.acquire(key);
    try {
      await sub.ready;
      await runtime.watch.poke(key);
    } finally {
      sub.release();
    }
    return { ...(await syncStatus(key)), cursor: runtime.hub.cursor() };
  }

  return { server, runtime };
}

export async function startMcpServer(opts: McpHostOptions = {}): Promise<void> {
  const { server, runtime } = createMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const stop = () => {
    runtime.close();
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.on("end", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

// Allow `node src/mcp/server.ts` directly (the CLI's `git-graph mcp` is the usual entry).
if (process.argv[1] && /[\\/]mcp[\\/]server\.(ts|js|mjs)$/.test(process.argv[1])) {
  void startMcpServer();
}
