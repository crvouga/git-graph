// The companion as a Zero source agent: it connects to the hosted server's Zero endpoint with its
// agent token, publishes the repositories it knows, serves demands / reads / operations for them
// and runs the repository-less companion commands (open, clone, init) queued from the web app.

import { Zero } from "@rocicorp/zero";
import { executeCommand } from "../core/commands/registry.ts";
import { AppError, type RepoInfo } from "../core/types.ts";
import { startZeroAgent, type AgentZero, type ZeroWriter } from "../agent/zero-agent.ts";
import type { OperationRow } from "../agent/host.ts";
import { mutators } from "../zero/mutators.ts";
import { schema } from "../zero/schema.ts";
import type { ServerAgent } from "./config.ts";
import type { LocalRuntime } from "./runtime.ts";

export type AgentLog = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

/** Companion commands an operation without a repository may run. */
export const AGENT_COMMANDS = new Set(["local.open", "local.clone", "local.init"]);

export type AgentState =
  | "checking" // asking the server who we are
  | "unpaired" // registered, waiting for someone to claim the pairing code
  | "unauthorized" // the server does not know our token
  | "unreachable" // the server did not answer (retrying)
  | "connecting"
  | "connected"
  | "error"
  | "stopped";

export interface AgentStatus {
  url: string;
  agentId: string;
  state: AgentState;
  message?: string;
}

export interface CompanionAgent {
  status(): AgentStatus;
  /** Publish (or update) a repository so the web app lists it. No-op until connected. */
  publish(key: string): Promise<void>;
  stop(): void;
}

export interface CompanionAgentOptions {
  /** How often to re-check pairing / reachability (ms). */
  retryMs?: number;
  heartbeatMs?: number;
  fetch?: typeof fetch;
}

interface Me {
  agentId: string;
  paired: boolean;
  /**
   * The account this companion is bound to. The agent queries filter by it, and Zero evaluates
   * them on the client too, so the client context must carry it or every row is filtered out.
   */
  accountId?: string | null;
}

const PAIR_HINT = "run `git-graph pair`";

async function whoAmI(f: typeof fetch, server: ServerAgent): Promise<Me> {
  let res: Response;
  try {
    res = await f(`${server.url}/agent-api/v1/me`, { headers: { authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new AppError("OFFLINE", `Cannot reach ${server.url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401 || res.status === 403) throw new AppError("UNAUTHENTICATED", `${server.url} does not recognise this companion; ${PAIR_HINT}`);
  if (!res.ok) throw new AppError("OFFLINE", `${server.url} answered HTTP ${res.status}`);
  return (await res.json()) as Me;
}

export function startCompanionAgent(runtime: LocalRuntime, server: ServerAgent, log: AgentLog, opts: CompanionAgentOptions = {}): CompanionAgent {
  const f = opts.fetch ?? fetch;
  const retryMs = opts.retryMs ?? 5_000;
  const status: AgentStatus = { url: server.url, agentId: server.agentId, state: "checking" };
  const held = new Map<string, () => void>();
  const inFlight = new Map<string, Promise<void>>();
  let zero: AgentZero | null = null;
  let agent: { writer: ZeroWriter; stop: () => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubState: (() => void) | null = null;
  let stopped = false;
  let accountId: string | null = null;

  const set = (state: AgentState, message?: string) => {
    if (status.state === state && status.message === message) return;
    status.state = state;
    if (message) status.message = message;
    else delete status.message;
    if (message) log(state === "connected" || state === "connecting" || state === "unpaired" ? "info" : "warn", message, { server: server.url, agentId: server.agentId });
  };

  const later = (fn: () => void, ms = retryMs) => {
    if (stopped) return;
    timer = setTimeout(fn, ms);
    (timer as { unref?: () => void }).unref?.();
  };

  async function publishNow(key: string) {
    if (!agent) return;
    const a = await runtime.local.local(key);
    const [info, caps] = await Promise.all([a.info(), a.capabilities()]);
    await agent.writer.repo(key, info, caps);
  }

  function publish(key: string): Promise<void> {
    if (!agent || !key.startsWith("local:")) return Promise.resolve();
    let p = inFlight.get(key);
    if (!p) {
      p = publishNow(key).finally(() => inFlight.delete(key));
      inFlight.set(key, p);
    }
    return p;
  }

  async function publishAll() {
    const repos = await runtime.local.list({ limit: 10_000 });
    for (const r of repos) {
      await publish(r.key).catch((e) => log("warn", `Could not publish ${r.name}: ${AppError.from(e).message}`, { repo: r.key }));
    }
  }

  async function agentOperation(op: OperationRow): Promise<unknown> {
    if (!AGENT_COMMANDS.has(op.command)) throw new AppError("UNSUPPORTED", `The companion does not run "${op.command}" without a repository`);
    const res = await executeCommand(runtime.registry, { appOrigin: server.url, actor: "ui" }, { command: op.command, args: op.args, ...(op.confirm ? { confirm: op.confirm } : {}) });
    if (!res.ok) throw new AppError(res.error.code, res.error.message, res.error.details);
    const info = res.result as RepoInfo;
    await publish(info.key);
    return info;
  }

  function connect() {
    if (stopped) return;
    set("connecting", `Connecting to ${server.url} as ${server.agentId}`);
    const z = new Zero({
      cacheURL: `${server.url}/zero`,
      userID: `agent:${server.agentId}`,
      auth: server.token,
      schema,
      mutators,
      kvStore: "mem",
      context: { accountId, agentId: server.agentId, skipLocalIngest: true },
    }) as unknown as AgentZero;
    zero = z;
    unsubState = z.connection.state.subscribe((s) => {
      if (s.name === "connected") {
        set("connected", `Connected to ${server.url}; serving local repositories`);
        void publishAll();
      } else if (s.name === "needs-auth") set("unauthorized", `${server.url} rejected this companion's token; ${PAIR_HINT}`);
      else if (s.name === "error") set("error", `Sync with ${server.url} failed (${s.reason}); ${PAIR_HINT} if this persists`);
      else if (s.name === "disconnected") set("connecting", `Disconnected from ${server.url} (${s.reason}); retrying`);
    });
    agent = startZeroAgent({
      zero: z,
      agentId: server.agentId,
      provider: "local",
      awaitServer: true,
      registry: runtime.registry,
      appOrigin: server.url,
      heartbeatMs: opts.heartbeatMs ?? 30_000,
      portFor: async (repoId) => {
        const port = await runtime.local.local(repoId);
        if (!held.has(repoId)) held.set(repoId, runtime.acquire(repoId).release);
        return port;
      },
      agentOperation,
      log,
    });
  }

  async function check() {
    if (stopped) return;
    try {
      const me = await whoAmI(f, server);
      if (stopped) return;
      if (!me.paired) {
        set("unpaired", `Waiting for this companion to be paired with an account; open the link from ${PAIR_HINT}`);
        return later(() => void check());
      }
      accountId = me.accountId ?? null;
      if (!accountId) log("warn", `${server.url} did not say which account this companion belongs to; it will not see demands or operations`, { server: server.url });
      connect();
    } catch (e) {
      const err = AppError.from(e);
      if (err.code === "UNAUTHENTICATED") return set("unauthorized", err.message); // no retry: needs a new pairing
      set("unreachable", `${err.message}; retrying`);
      later(() => void check(), Math.max(retryMs, 15_000));
    }
  }

  const unsubOpened = runtime.local.onOpened((info) => {
    void publish(info.key).catch((e) => log("warn", `Could not publish ${info.name}: ${AppError.from(e).message}`, { repo: info.key }));
  });

  void check();

  return {
    status: () => ({ ...status }),
    publish,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubOpened();
      unsubState?.();
      agent?.stop();
      agent = null;
      for (const release of held.values()) release();
      held.clear();
      void zero?.close().catch(() => {});
      zero = null;
      status.state = "stopped";
    },
  };
}
