// Git process execution. Argument arrays only (never a shell), stdin closed unless input is piped,
// no terminal prompts. User config, hooks, signing, SSH agent and credential helpers are respected:
// we only add `-c core.quotepath=false` and `--no-pager` to every invocation.

import { spawn, type ChildProcess } from "node:child_process";
import { AppError } from "../core/types.ts";
import { displayCommand, scrubText } from "../core/git/text.ts";

export const MIN_GIT = [2, 30, 0] as const;

export interface RunOptions {
  cwd: string;
  input?: string | Uint8Array;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Read-only command: GIT_OPTIONAL_LOCKS=0 so status/diff never rewrite the index (no watcher loops). */
  readOnly?: boolean;
  /** Use the C locale (stable, parseable messages). */
  cLocale?: boolean;
  /** Abort and mark truncated once stdout exceeds this many bytes. */
  maxBytes?: number;
  /** Return raw bytes instead of text. */
  binary?: boolean;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stdoutBytes?: Buffer;
  stderr: string;
  code: number;
  truncated: boolean;
  /** Display form of the invocation (credentials scrubbed). */
  invocation: string;
}

export function gitEnv(extra?: Record<string, string | undefined>, opts?: { readOnly?: boolean; cLocale?: boolean }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  // Never let git open a pager or an interactive editor in a background process.
  env.GIT_PAGER = "cat";
  if (opts?.readOnly) env.GIT_OPTIONAL_LOCKS = "0";
  if (opts?.cLocale) {
    env.LC_ALL = "C";
    env.LANGUAGE = "C";
  }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export function gitArgs(args: readonly string[]): string[] {
  return ["--no-pager", "-c", "core.quotepath=false", ...args];
}

/** Spawn git and collect output. Never throws for a non-zero exit: callers decide. */
export function runGit(args: readonly string[], opts: RunOptions): Promise<RunResult> {
  const full = gitArgs(args);
  const invocation = scrubText(displayCommand("git", args));
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn("git", full, {
        cwd: opts.cwd,
        env: gitEnv(opts.env, opts),
        stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        signal: opts.signal,
        windowsHide: true,
      });
    } catch (e) {
      reject(mapSpawnError(e));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let truncated = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (opts.timeoutMs) timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    child.stdout!.on("data", (b: Buffer) => {
      if (truncated) return;
      if (opts.maxBytes !== undefined && outLen + b.length > opts.maxBytes) {
        out.push(b.subarray(0, Math.max(0, opts.maxBytes - outLen)));
        outLen = opts.maxBytes;
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      out.push(b);
      outLen += b.length;
    });
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      if ((e as NodeJS.ErrnoException).name === "AbortError") reject(new AppError("CANCELLED", "Git command was cancelled"));
      else reject(mapSpawnError(e));
    });
    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      const bytes = Buffer.concat(out);
      resolve({
        stdout: opts.binary ? "" : bytes.toString("utf8"),
        stdoutBytes: opts.binary ? bytes : undefined,
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? (truncated ? 0 : sig ? 128 : 1),
        truncated,
        invocation,
      });
    });
    if (opts.input !== undefined) {
      child.stdin!.on("error", () => {
        /* git may exit before reading all input (EPIPE); the exit code tells the story */
      });
      child.stdin!.end(opts.input);
    }
  });
}

function mapSpawnError(e: unknown): AppError {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") return new AppError("GIT_MISSING", `Git was not found on PATH. Install Git ${MIN_GIT.join(".")} or newer.`);
  return AppError.from(e);
}

/** Run and throw GIT_FAILED (with git's stderr) on a non-zero exit. */
export async function git(args: readonly string[], opts: RunOptions): Promise<string> {
  const r = await runGit(args, opts);
  if (r.code !== 0) throw gitFailure(r);
  return r.stdout;
}

export function gitFailure(r: RunResult, extra?: Record<string, unknown>): AppError {
  const msg = scrubText(r.stderr.trim() || r.stdout.trim() || `git exited with code ${r.code}`);
  return new AppError("GIT_FAILED", msg, { exitCode: r.code, invocation: r.invocation, ...extra });
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

export interface GitVersionInfo {
  raw: string;
  version: [number, number, number];
  ok: boolean;
  problem?: string;
}

let versionPromise: Promise<GitVersionInfo> | null = null;

export function parseGitVersion(s: string): [number, number, number] | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function versionAtLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) > (min[i] ?? 0)) return true;
    if ((v[i] ?? 0) < (min[i] ?? 0)) return false;
  }
  return true;
}

export function gitVersion(): Promise<GitVersionInfo> {
  versionPromise ??= runGit(["--version"], { cwd: process.cwd() })
    .then((r): GitVersionInfo => {
      const v = parseGitVersion(r.stdout);
      if (!v) return { raw: r.stdout.trim(), version: [0, 0, 0], ok: false, problem: `Could not determine the Git version ("${r.stdout.trim()}"). Git ${MIN_GIT.join(".")} or newer is required.` };
      const ok = versionAtLeast(v, MIN_GIT);
      return {
        raw: r.stdout.trim(),
        version: v,
        ok,
        ...(ok ? {} : { problem: `Git ${v.join(".")} is too old. Git ${MIN_GIT.join(".")} or newer is required.` }),
      };
    })
    .catch((e): GitVersionInfo => ({ raw: "", version: [0, 0, 0], ok: false, problem: AppError.from(e).message }));
  return versionPromise;
}

export async function requireGit(): Promise<GitVersionInfo> {
  const v = await gitVersion();
  if (!v.ok) throw new AppError("GIT_MISSING", v.problem ?? "Git is unavailable");
  return v;
}

/** Spawn a long-running git process with piped stdout (history streaming). */
export function spawnGitStream(args: readonly string[], cwd: string): ChildProcess {
  return spawn("git", gitArgs(args), { cwd, env: gitEnv(undefined, { readOnly: true }), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}
