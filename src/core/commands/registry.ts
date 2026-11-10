// One declarative command registry for UI, palette, shortcuts, context menus, HTTP API, CLI and MCP.
// A command validates its arguments with a schema, declares availability, and (when destructive)
// describes the exact consequence. Execution always goes through `executeCommand`, so every
// interface shares validation, capability checks and the destructive-action policy.

import { z } from "zod";
import { AppError, type Capability } from "../types.ts";
import type { RepositoryPort, RepositoryResolver } from "../port.ts";

export type Availability = { enabled: true } | { enabled: false; reason: string };

export type CommandKind = "query" | "mutation" | "ui";

export type MenuContext = "graph" | "commit" | "ref" | "stash" | "uncommitted" | "file" | "diff" | "worktree";

export type CommandCategory =
  | "Navigation"
  | "View"
  | "Repository"
  | "Branch"
  | "Tag"
  | "Commit"
  | "Working Tree"
  | "Stash"
  | "Remote"
  | "Worktree"
  | "History"
  | "Links"
  | "Account"
  | "Help";

/** Execution context. Hosts (server, companion, browser UI) supply what they have. */
export interface CommandContext {
  resolver?: RepositoryResolver;
  /** Repository the UI is focused on; repo commands fall back to it when args.repo is absent. */
  repo?: RepositoryPort;
  /** Origin used to build deep links, e.g. "https://git-graph.example.com". */
  appOrigin: string;
  /** Who is calling (for audit / logs). */
  actor?: "ui" | "api" | "cli" | "mcp";
  /** Host-specific extras (UI state, etc.). */
  host?: unknown;
  signal?: AbortSignal;
}

export interface CommandDef<S extends z.ZodType = z.ZodType, R = unknown> {
  id: string;
  title: string;
  description: string;
  category: CommandCategory;
  kind: CommandKind;
  args: S;
  /** Adapter capability required (checked against the target repository). */
  capability?: Capability;
  /** Default key bindings, e.g. ["Mod+Shift+P"]. "Mod" = Cmd on macOS, Ctrl elsewhere. */
  shortcuts?: string[];
  /** Context menus this command appears in. */
  contexts?: MenuContext[];
  /** Hidden from the palette (still callable). */
  hidden?: boolean;
  /** Extra availability rule beyond capability. */
  when?: (ctx: CommandContext, args: Partial<z.infer<S>>) => Availability | Promise<Availability>;
  /** Return the exact consequence for destructive invocations, or null when this invocation is safe. */
  destructive?: (args: z.infer<S>, ctx: CommandContext) => string | null | Promise<string | null>;
  execute: (args: z.infer<S>, ctx: CommandContext) => Promise<R> | R;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommand = CommandDef<any, any>;

export function defineCommand<S extends z.ZodType, R>(def: CommandDef<S, R>): CommandDef<S, R> {
  return def;
}

export class CommandRegistry {
  private readonly commands = new Map<string, AnyCommand>();

  register(...defs: AnyCommand[]): this {
    for (const d of defs) {
      if (this.commands.has(d.id)) throw new Error(`Duplicate command id ${d.id}`);
      this.commands.set(d.id, d);
    }
    return this;
  }

  get(id: string): AnyCommand | undefined {
    return this.commands.get(id);
  }

  list(filter?: (c: AnyCommand) => boolean): AnyCommand[] {
    const all = [...this.commands.values()];
    return filter ? all.filter(filter) : all;
  }
}

// ---------------------------------------------------------------------------
// Confirmation tokens: a destructive call must echo a token derived from the exact consequence
// it was shown. This is an accident guard, not an authorization mechanism.
// ---------------------------------------------------------------------------

function fnv1a64(s: string): string {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0xcbf29ce4 | 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193 + 2);
  }
  return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")).slice(0, 16);
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export function confirmToken(commandId: string, args: unknown, consequence: string): string {
  return fnv1a64(`${commandId}\n${stableStringify(args)}\n${consequence}`);
}

// ---------------------------------------------------------------------------
// Availability and execution
// ---------------------------------------------------------------------------

export async function resolveRepo(ctx: CommandContext, key: string | undefined): Promise<RepositoryPort> {
  if (key) {
    if (ctx.repo && ctx.repo.key === key) return ctx.repo;
    if (!ctx.resolver) throw new AppError("BAD_REQUEST", "This host cannot open other repositories");
    return ctx.resolver.resolve(key);
  }
  if (ctx.repo) return ctx.repo;
  throw new AppError("BAD_REQUEST", 'Argument "repo" is required');
}

export async function availability(cmd: AnyCommand, ctx: CommandContext, args: Record<string, unknown> = {}): Promise<Availability> {
  try {
    if (cmd.capability) {
      const repo = await resolveRepo(ctx, args.repo as string | undefined).catch(() => null);
      if (!repo) return { enabled: false, reason: "Open a repository first" };
      const caps = await repo.capabilities({ signal: ctx.signal });
      const c = caps[cmd.capability];
      if (!c.available) return { enabled: false, reason: c.reason };
    }
    if (cmd.when) return await cmd.when(ctx, args);
    return { enabled: true };
  } catch (e) {
    return { enabled: false, reason: AppError.from(e).message };
  }
}

export interface ExecuteRequest {
  command: string;
  args?: unknown;
  /** Token from a previous CONFIRMATION_REQUIRED error, proving the caller saw the consequence. */
  confirm?: string;
}

export type ExecuteResponse =
  | { ok: true; command: string; result: unknown }
  | { ok: false; command: string; error: ReturnType<AppError["toJSON"]> };

export async function executeCommand(
  registry: CommandRegistry,
  ctx: CommandContext,
  req: ExecuteRequest,
): Promise<ExecuteResponse> {
  const cmd = registry.get(req.command);
  try {
    if (!cmd) throw new AppError("NOT_FOUND", `Unknown command "${req.command}"`);
    const parsed = cmd.args.safeParse(req.args ?? {});
    if (!parsed.success) {
      throw new AppError("BAD_REQUEST", `Invalid arguments for ${cmd.id}: ${z.prettifyError(parsed.error)}`, {
        issues: parsed.error.issues,
      });
    }
    const args = parsed.data as Record<string, unknown>;
    const avail = await availability(cmd, ctx, args);
    if (!avail.enabled) throw new AppError("UNSUPPORTED", avail.reason, { command: cmd.id, capability: cmd.capability });
    if (cmd.destructive) {
      const consequence = await cmd.destructive(args, ctx);
      if (consequence) {
        const token = confirmToken(cmd.id, args, consequence);
        if (req.confirm !== token) {
          throw new AppError("CONFIRMATION_REQUIRED", consequence, { consequence, confirmToken: token, command: cmd.id });
        }
      }
    }
    const result = await cmd.execute(args, ctx);
    return { ok: true, command: cmd.id, result };
  } catch (e) {
    return { ok: false, command: req.command, error: AppError.from(e).toJSON() };
  }
}

/** JSON-schema description of a command for /api/v1/commands, MCP and `git-graph commands`. */
export function describeCommand(cmd: AnyCommand) {
  let schema: unknown;
  try {
    schema = z.toJSONSchema(cmd.args, { unrepresentable: "any" });
  } catch {
    schema = { type: "object" };
  }
  return {
    id: cmd.id,
    title: cmd.title,
    description: cmd.description,
    category: cmd.category,
    kind: cmd.kind,
    capability: cmd.capability ?? null,
    destructive: Boolean(cmd.destructive),
    shortcuts: cmd.shortcuts ?? [],
    contexts: cmd.contexts ?? [],
    argsSchema: schema,
  };
}
