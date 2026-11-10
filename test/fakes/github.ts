// A fake GitHub (REST subset + OAuth + tiny GraphQL) for integration tests. Backed by a real git
// repository: commits, refs, diffs, contents and blame are read with git, so graph tests can be
// compared against `git log`. Never talks to github.com.

import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { makeBasic, ROOT } from "../fixtures/make-fixtures.ts";

export type Perm = "read" | "triage" | "write" | "maintain" | "admin";

export interface FakeUser {
  id: number;
  login: string;
  name: string;
}

export interface FakeCommit {
  sha: string;
  parents: string[];
  author: { name: string; email: string; date: number };
  committer: { name: string; email: string; date: number };
  message: string;
  /** Real commits are diffed with git; synthetic commits (pushCommit) carry their own file list. */
  real: boolean;
  /** For synthetic commits: nearest real commit whose tree they share. */
  treeOf?: string;
  files?: GhFileOut[];
}

interface GhFileOut {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  sha?: string;
}

export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  /** "refs/heads/x" → sha (commit or tag object). */
  refs: Map<string, string>;
  tagObjects: Map<string, { tag: string; message: string; object: string }>;
  commits: Map<string, FakeCommit>;
  gitDir: string | null;
  perms: Map<string, Perm>;
}

interface TokenInfo {
  login: string;
  expiresAt: number | null;
}

export interface RequestLog {
  method: string;
  path: string;
  status: number;
  login: string | null;
  at: number;
}

const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const gitBuf = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });

/** Build (once per process) a basic fixture repo for fake-GitHub tests. */
export function makeGitHubFixture(): string {
  const root = join(ROOT, `gh-fake-${process.pid}`);
  const repo = join(root, "basic");
  if (existsSync(join(repo, ".git", "lanes-fixture-done"))) return repo;
  mkdirSync(ROOT, { recursive: true });
  // fixtureEnv() points GIT_CONFIG_GLOBAL at ROOT/.gitconfig; make sure it exists (identical content).
  if (!existsSync(join(ROOT, ".gitconfig"))) {
    writeFileSync(join(ROOT, ".gitconfig"), "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n");
  }
  makeBasic(root);
  writeFileSync(join(repo, ".git", "lanes-fixture-done"), "1");
  return repo;
}

export function cleanupGitHubFixture() {
  rmSync(join(ROOT, `gh-fake-${process.pid}`), { recursive: true, force: true });
}

export function signWebhook(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function iso(unix: number): string {
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export interface FakeGitHubOptions {
  clientId?: string;
  clientSecret?: string;
  /** Access token lifetime in seconds (GitHub App user tokens: 28800). null = non-expiring. */
  accessTokenTtl?: number | null;
  anonRateLimit?: number;
  authRateLimit?: number;
  /** Artificial latency per request (ms). */
  latencyMs?: number;
}

export class FakeGitHub {
  readonly app = new Hono();
  url = "";
  readonly users = new Map<string, FakeUser>();
  readonly repos = new Map<string, FakeRepo>();
  readonly tokens = new Map<string, TokenInfo>();
  readonly refreshTokens = new Map<string, { login: string; revoked: boolean }>();
  readonly codes = new Map<string, { login: string; clientId: string; redirectUri: string; challenge?: string; method?: string; used: boolean; at: number }>();
  readonly log: RequestLog[] = [];
  readonly opts: Required<FakeGitHubOptions>;
  /** User who "clicks Authorize" in the OAuth flow. */
  authorizingUser: string | null = null;
  private readonly rate = new Map<string, { limit: number; remaining: number; reset: number }>();
  private readonly blocked = new Map<string, { until: number; secondary: boolean }>();
  private server: ReturnType<typeof serve> | null = null;
  private nextId = 1000;
  private fileCache = new Map<string, GhFileOut[]>();
  /** Clock skew for synthetic commits (seconds). */
  clock = 1_800_000_000;

  constructor(opts: FakeGitHubOptions = {}) {
    this.opts = {
      clientId: opts.clientId ?? "Iv1.fakeclient",
      clientSecret: opts.clientSecret ?? "fake-client-secret",
      accessTokenTtl: opts.accessTokenTtl === undefined ? 28800 : opts.accessTokenTtl,
      anonRateLimit: opts.anonRateLimit ?? 100_000,
      authRateLimit: opts.authRateLimit ?? 100_000,
      latencyMs: opts.latencyMs ?? 0,
    };
    this.app.all("*", (c) => this.handle(c));
  }

  async start(): Promise<this> {
    await new Promise<void>((res) => {
      this.server = serve({ fetch: this.app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        this.url = `http://127.0.0.1:${info.port}`;
        res();
      });
    });
    return this;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((res) => {
      (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      s.close(() => res());
    });
  }

  // -------------------------------------------------------------------------
  // Setup helpers
  // -------------------------------------------------------------------------

  addUser(login: string, name = login): FakeUser {
    const u = { id: this.nextId++, login, name };
    this.users.set(login, u);
    return u;
  }

  /** Issue a token directly (bypassing OAuth). */
  issueToken(login: string, ttlSec: number | null = null): string {
    const t = `ghu_${randomBytes(18).toString("hex")}`;
    this.tokens.set(t, { login, expiresAt: ttlSec === null ? null : Date.now() + ttlSec * 1000 });
    return t;
  }

  addRepoFromGit(owner: string, name: string, dir: string, opts: { private?: boolean; perms?: Record<string, Perm>; defaultBranch?: string } = {}): FakeRepo {
    const commits = new Map<string, FakeCommit>();
    const out = git(dir, ["log", "--branches", "--tags", "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B%x1e"]);
    for (const rec of out.split("\x1e")) {
      const r = rec.replace(/^\n/, "");
      if (!r.trim()) continue;
      const [sha, parents, an, ae, at, cn, ce, ct, ...msg] = r.split("\x00");
      commits.set(sha!, {
        sha: sha!,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        author: { name: an!, email: ae!, date: Number(at) },
        committer: { name: cn!, email: ce!, date: Number(ct) },
        message: msg.join("\x00").replace(/\n+$/, ""),
        real: true,
      });
    }
    const refs = new Map<string, string>();
    const tagObjects = new Map<string, { tag: string; message: string; object: string }>();
    const refOut = git(dir, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(contents:subject)", "refs/heads", "refs/tags"]);
    for (const line of refOut.split("\n")) {
      if (!line) continue;
      const [ref, sha, type, peeled, subject] = line.split("\x00");
      refs.set(ref!, sha!);
      if (type === "tag") tagObjects.set(sha!, { tag: ref!.slice("refs/tags/".length), message: subject ?? "", object: peeled! });
    }
    const repo: FakeRepo = {
      id: this.nextId++,
      owner,
      name,
      private: !!opts.private,
      defaultBranch: opts.defaultBranch ?? "main",
      refs,
      tagObjects,
      commits,
      gitDir: dir,
      perms: new Map(Object.entries(opts.perms ?? {})),
    };
    this.repos.set(`${owner}/${name}`.toLowerCase(), repo);
    return repo;
  }

  repo(owner: string, name: string): FakeRepo {
    const r = this.repos.get(`${owner}/${name}`.toLowerCase());
    if (!r) throw new Error(`no fake repo ${owner}/${name}`);
    return r;
  }

  /** Simulate `git push` of one new commit on a branch (out-of-band of the API). */
  pushCommit(owner: string, name: string, branch: string, opts: { message?: string; date?: number; parents?: string[] } = {}) {
    const repo = this.repo(owner, name);
    const ref = `refs/heads/${branch}`;
    const before = repo.refs.get(ref) ?? "0".repeat(40);
    const parents = opts.parents ?? (repo.refs.has(ref) ? [before] : []);
    const date = opts.date ?? ++this.clock;
    const sha = createHash("sha1").update(`${randomBytes(8).toString("hex")}${date}`).digest("hex");
    const base = parents[0] ? repo.commits.get(parents[0]) : undefined;
    repo.commits.set(sha, {
      sha,
      parents,
      author: { name: "Pusher", email: "pusher@example.com", date },
      committer: { name: "Pusher", email: "pusher@example.com", date },
      message: opts.message ?? `Synthetic commit ${sha.slice(0, 7)}`,
      real: false,
      treeOf: base ? (base.real ? base.sha : base.treeOf) : undefined,
      files: [],
    });
    repo.refs.set(ref, sha);
    return { before, after: sha, ref, payload: this.pushPayload(repo, ref, before, sha, [sha]) };
  }

  setRef(owner: string, name: string, ref: string, sha: string | null) {
    const repo = this.repo(owner, name);
    if (sha === null) repo.refs.delete(ref);
    else repo.refs.set(ref, sha);
  }

  repoPayload(repo: FakeRepo) {
    return { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, owner: { login: repo.owner, name: repo.owner }, default_branch: repo.defaultBranch };
  }

  pushPayload(repo: FakeRepo, ref: string, before: string, after: string, ids: string[]) {
    return {
      ref,
      before,
      after,
      created: /^0+$/.test(before),
      deleted: /^0+$/.test(after),
      forced: false,
      commits: ids.map((id) => ({ id, message: repo.commits.get(id)?.message ?? "", timestamp: iso(repo.commits.get(id)?.committer.date ?? 0) })),
      head_commit: ids.length ? { id: ids[ids.length - 1] } : null,
      repository: this.repoPayload(repo),
      sender: { login: "pusher", id: 1 },
    };
  }

  refPayload(owner: string, name: string, ref: string, refType: "branch" | "tag") {
    return { ref, ref_type: refType, repository: this.repoPayload(this.repo(owner, name)), sender: { login: "pusher", id: 1 } };
  }

  /** Make GitHub answer the next requests for `token` (or anonymous) with a rate limit. */
  rateLimit(token: string | null, opts: { secondary?: boolean; seconds?: number } = {}) {
    this.blocked.set(this.identity(token), { until: Date.now() + (opts.seconds ?? 60) * 1000, secondary: !!opts.secondary });
  }

  revokeRefreshTokens(login: string) {
    for (const r of this.refreshTokens.values()) if (r.login === login) r.revoked = true;
  }

  expireAccessTokens(login: string) {
    for (const t of this.tokens.values()) if (t.login === login) t.expiresAt = Date.now() - 1000;
  }

  countRequests(filter?: (r: RequestLog) => boolean): number {
    return filter ? this.log.filter(filter).length : this.log.length;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private identity(token: string | null): string {
    return token ? `tok:${this.tokens.get(token)?.login ?? token}` : "anon";
  }

  private async handle(c: Context): Promise<Response> {
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    const url = new URL(c.req.url);
    const auth = c.req.header("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth?.startsWith("token ") ? auth.slice(6) : null;
    let login: string | null = null;
    let res: Response;
    try {
      if (url.pathname.startsWith("/login/oauth/")) {
        res = await this.oauth(c, url);
      } else {
        if (token) {
          const t = this.tokens.get(token);
          if (!t || (t.expiresAt !== null && t.expiresAt < Date.now())) {
            res = this.json({ message: "Bad credentials" }, 401);
            return this.finish(c, url, res, null);
          }
          login = t.login;
        }
        const blocked = this.blocked.get(this.identity(token));
        if (blocked && blocked.until > Date.now()) {
          const h: Record<string, string> = blocked.secondary ? { "retry-after": String(Math.ceil((blocked.until - Date.now()) / 1000)) } : this.rateHeaders(token, false, true);
          res = this.json({ message: blocked.secondary ? "You have exceeded a secondary rate limit." : "API rate limit exceeded" }, 403, h);
          return this.finish(c, url, res, login);
        }
        res = await this.api(c, url, login);
        const notModified = res.status === 304;
        for (const [k, v] of Object.entries(this.rateHeaders(token, !notModified))) res.headers.set(k, v);
      }
    } catch (e) {
      if (e instanceof Response) res = e;
      else res = this.json({ message: e instanceof Error ? e.message : String(e) }, 500);
    }
    return this.finish(c, url, res, login);
  }

  private finish(c: Context, url: URL, res: Response, login: string | null): Response {
    this.log.push({ method: c.req.method, path: url.pathname + url.search, status: res.status, login, at: Date.now() });
    return res;
  }

  private rateHeaders(token: string | null, consume: boolean, exhausted = false): Record<string, string> {
    const id = this.identity(token);
    let r = this.rate.get(id);
    const now = Math.floor(Date.now() / 1000);
    if (!r || r.reset < now) {
      r = { limit: token ? this.opts.authRateLimit : this.opts.anonRateLimit, remaining: token ? this.opts.authRateLimit : this.opts.anonRateLimit, reset: now + 3600 };
      this.rate.set(id, r);
    }
    if (consume && r.remaining > 0) r.remaining--;
    return {
      "x-ratelimit-limit": String(r.limit),
      "x-ratelimit-remaining": String(exhausted ? 0 : r.remaining),
      "x-ratelimit-reset": String(r.reset),
      "x-ratelimit-used": String(r.limit - r.remaining),
    };
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  /** JSON response with ETag + conditional handling. */
  private cond(c: Context, body: unknown, login: string | null, headers: Record<string, string> = {}): Response {
    const text = JSON.stringify(body);
    const etag = `W/"${createHash("sha1").update(text).update(login ?? "").digest("hex")}"`;
    if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, ...headers } });
    return new Response(text, { status: 200, headers: { "content-type": "application/json", etag, "cache-control": "private, max-age=60", ...headers } });
  }

  private paged<T>(c: Context, url: URL, items: T[], login: string | null): Response {
    const per = Math.min(100, Math.max(1, Number(url.searchParams.get("per_page") ?? 30)));
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const slice = items.slice((page - 1) * per, page * per);
    const headers: Record<string, string> = {};
    if (page * per < items.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      next.searchParams.set("per_page", String(per));
      headers.link = `<${next.toString()}>; rel="next"`;
    }
    return this.cond(c, slice, login, headers);
  }

  private perm(repo: FakeRepo, login: string | null): Perm | null {
    if (login && repo.perms.has(login)) return repo.perms.get(login)!;
    if (!repo.private) return "read";
    return null;
  }

  private permissions(p: Perm | null) {
    const rank = { read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };
    const r = p ? rank[p] : 0;
    return { pull: r >= 1, triage: r >= 2, push: r >= 3, maintain: r >= 4, admin: r >= 5 };
  }

  private repoJson(repo: FakeRepo, login: string | null) {
    return {
      ...this.repoPayload(repo),
      visibility: repo.private ? "private" : "public",
      description: `Fake ${repo.name}`,
      html_url: `${this.url}/${repo.owner}/${repo.name}`,
      updated_at: iso(this.clock),
      ...(login ? { permissions: this.permissions(this.perm(repo, login)) } : {}),
    };
  }

  private commitJson(repo: FakeRepo, c: FakeCommit, withFiles = false) {
    const person = (p: FakeCommit["author"]) => ({ name: p.name, email: p.email, date: iso(p.date) });
    return {
      sha: c.sha,
      node_id: `C_${c.sha}`,
      commit: { author: person(c.author), committer: person(c.committer), message: c.message, verification: { verified: false, reason: "unsigned" } },
      parents: c.parents.map((sha) => ({ sha })),
      html_url: `${this.url}/${repo.owner}/${repo.name}/commit/${c.sha}`,
      ...(withFiles ? { files: this.filesFor(repo, c) } : {}),
    };
  }

  private peel(repo: FakeRepo, sha: string): string {
    return repo.tagObjects.get(sha)?.object ?? sha;
  }

  private resolve(repo: FakeRepo, rev: string): string | null {
    if (repo.commits.has(rev)) return rev;
    for (const r of [rev, `refs/heads/${rev}`, `refs/tags/${rev}`]) {
      const s = repo.refs.get(r);
      if (s) return this.peel(repo, s);
    }
    if (/^[0-9a-f]{4,39}$/.test(rev)) {
      const hits = [...repo.commits.keys()].filter((k) => k.startsWith(rev));
      if (hits.length === 1) return hits[0]!;
    }
    return null;
  }

  /** git-log-like walk: date-ordered priority queue from `start`. */
  walk(repo: FakeRepo, start: string): FakeCommit[] {
    const out: FakeCommit[] = [];
    const seen = new Set<string>([start]);
    const queue: FakeCommit[] = [];
    const first = repo.commits.get(start);
    if (first) queue.push(first);
    while (queue.length) {
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i]!.committer.date > queue[bi]!.committer.date) bi = i;
      const c = queue.splice(bi, 1)[0]!;
      out.push(c);
      for (const p of c.parents) {
        if (seen.has(p)) continue;
        seen.add(p);
        const pc = repo.commits.get(p);
        if (pc) queue.push(pc);
      }
    }
    return out;
  }

  private ancestors(repo: FakeRepo, sha: string): Set<string> {
    const s = new Set<string>();
    const st = [sha];
    while (st.length) {
      const x = st.pop()!;
      if (s.has(x)) continue;
      s.add(x);
      for (const p of repo.commits.get(x)?.parents ?? []) st.push(p);
    }
    return s;
  }

  private diffFiles(dir: string, from: string | null, to: string): GhFileOut[] {
    const key = `${from}..${to}`;
    const hit = this.fileCache.get(key);
    if (hit) return hit;
    const range = from ? [from, to] : ["--root", to];
    const ns = git(dir, ["diff-tree", "-r", "-M", "--name-status", "-z", ...range]).split("\x00");
    const files: GhFileOut[] = [];
    let i = from ? 0 : 1; // --root prints the commit sha first
    if (!from && ns[0] && !/^[0-9a-f]{40}$/.test(ns[0])) i = 0;
    while (i < ns.length) {
      const st = ns[i++];
      if (!st) continue;
      let path = ns[i++]!;
      let old: string | undefined;
      if (st.startsWith("R") || st.startsWith("C")) {
        old = path;
        path = ns[i++]!;
      }
      const patchOut = git(dir, ["diff-tree", "-r", "-M", "-p", "--no-color", ...range, "--", ...(old ? [old, path] : [path])]);
      const binary = /^Binary files /m.test(patchOut);
      const at = patchOut.indexOf("\n@@");
      const patch = at >= 0 ? patchOut.slice(at + 1).replace(/\n$/, "") : undefined;
      let additions = 0;
      let deletions = 0;
      for (const l of (patch ?? "").split("\n")) {
        if (l.startsWith("+")) additions++;
        else if (l.startsWith("-")) deletions++;
      }
      const status = st[0] === "A" ? "added" : st[0] === "D" ? "removed" : st[0] === "R" ? "renamed" : st[0] === "C" ? "copied" : st[0] === "T" ? "changed" : "modified";
      files.push({
        filename: path,
        ...(old ? { previous_filename: old } : {}),
        status,
        additions,
        deletions,
        changes: additions + deletions,
        ...(patch && !binary ? { patch } : {}),
        sha: createHash("sha1").update(path + to).digest("hex"),
      });
    }
    this.fileCache.set(key, files);
    return files;
  }

  filesFor(repo: FakeRepo, c: FakeCommit): GhFileOut[] {
    if (!c.real || !repo.gitDir) return c.files ?? [];
    return this.diffFiles(repo.gitDir, c.parents[0] ?? null, c.sha);
  }

  private notFound(): Response {
    return this.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
  }

  private async body(c: Context): Promise<Record<string, unknown>> {
    const t = await c.req.text();
    if (!t) return {};
    try {
      return JSON.parse(t) as Record<string, unknown>;
    } catch {
      return Object.fromEntries(new URLSearchParams(t));
    }
  }

  private async oauth(c: Context, url: URL): Promise<Response> {
    if (url.pathname === "/login/oauth/authorize") {
      const q = url.searchParams;
      if (q.get("client_id") !== this.opts.clientId) return new Response("bad client", { status: 400 });
      if (!this.authorizingUser) return new Response("nobody signed in", { status: 403 });
      const code = randomBytes(10).toString("hex");
      this.codes.set(code, {
        login: this.authorizingUser,
        clientId: q.get("client_id")!,
        redirectUri: q.get("redirect_uri") ?? "",
        challenge: q.get("code_challenge") ?? undefined,
        method: q.get("code_challenge_method") ?? undefined,
        used: false,
        at: Date.now(),
      });
      const to = new URL(q.get("redirect_uri")!);
      to.searchParams.set("code", code);
      if (q.get("state")) to.searchParams.set("state", q.get("state")!);
      return new Response(null, { status: 302, headers: { location: to.toString() } });
    }
    if (url.pathname === "/login/oauth/access_token" && c.req.method === "POST") {
      const b = await this.body(c);
      if (b.client_id !== this.opts.clientId || b.client_secret !== this.opts.clientSecret) return this.json({ error: "incorrect_client_credentials" });
      let login: string;
      if (b.grant_type === "refresh_token") {
        const r = this.refreshTokens.get(String(b.refresh_token));
        if (!r || r.revoked) return this.json({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." });
        r.revoked = true; // rotation
        login = r.login;
      } else {
        const code = this.codes.get(String(b.code));
        if (!code || code.used || Date.now() - code.at > 600_000) return this.json({ error: "bad_verification_code" });
        code.used = true;
        if (b.redirect_uri && b.redirect_uri !== code.redirectUri) return this.json({ error: "redirect_uri_mismatch" });
        if (code.challenge) {
          const v = String(b.code_verifier ?? "");
          const ok = code.method === "S256" ? b64url(createHash("sha256").update(v).digest()) === code.challenge : v === code.challenge;
          if (!v || !ok) return this.json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        }
        login = code.login;
      }
      const ttl = this.opts.accessTokenTtl;
      const access = this.issueToken(login, ttl);
      const refresh = `ghr_${randomBytes(18).toString("hex")}`;
      this.refreshTokens.set(refresh, { login, revoked: false });
      return this.json({
        access_token: access,
        token_type: "bearer",
        scope: "",
        ...(ttl !== null ? { expires_in: ttl, refresh_token: refresh, refresh_token_expires_in: 15897600 } : {}),
      });
    }
    return this.notFound();
  }

  private async api(c: Context, url: URL, login: string | null): Promise<Response> {
    const p = url.pathname;
    const m = c.req.method;
    let mm: RegExpExecArray | null;

    if (p === "/user" && m === "GET") {
      if (!login) return this.json({ message: "Requires authentication" }, 401);
      const u = this.users.get(login)!;
      return this.cond(c, { login: u.login, id: u.id, name: u.name, avatar_url: `https://avatars.githubusercontent.com/u/${u.id}` }, login);
    }
    if (p === "/user/repos" && m === "GET") {
      if (!login) return this.json({ message: "Requires authentication" }, 401);
      const list = [...this.repos.values()].filter((r) => r.perms.has(login)).map((r) => this.repoJson(r, login));
      return this.paged(c, url, list, login);
    }
    if (p === "/search/repositories" && m === "GET") {
      const q = (url.searchParams.get("q") ?? "").split(" ")[0]!.toLowerCase();
      const items = [...this.repos.values()].filter((r) => this.perm(r, login) && r.name.toLowerCase().includes(q)).map((r) => this.repoJson(r, login));
      return this.cond(c, { total_count: items.length, items }, login);
    }
    if (p === "/search/commits" && m === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const rm = /repo:([^/\s]+)\/(\S+)/.exec(q);
      const text = q.replace(/repo:\S+/, "").trim().toLowerCase();
      const repo = rm ? this.repos.get(`${rm[1]}/${rm[2]}`.toLowerCase()) : undefined;
      if (!repo || !this.perm(repo, login)) return this.json({ message: "Validation Failed" }, 422);
      const items = [...repo.commits.values()].filter((x) => x.message.toLowerCase().includes(text)).map((x) => this.commitJson(repo, x));
      return this.cond(c, { total_count: items.length, items }, login);
    }
    if (p === "/graphql" && m === "POST") return this.graphql(c, login);
    if (p === "/rate_limit") return this.cond(c, { resources: {} }, login);

    if (!(mm = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p))) return this.notFound();
    const repo = this.repos.get(`${decodeURIComponent(mm[1]!)}/${decodeURIComponent(mm[2]!)}`.toLowerCase());
    if (!repo) return this.notFound();
    const perm = this.perm(repo, login);
    if (!perm) return this.notFound(); // private and no access: indistinguishable from missing
    const rest = mm[3] ?? "";
    const canPush = ["write", "maintain", "admin"].includes(perm);
    const forbidden = () => this.json({ message: "Resource not accessible by integration" }, 403);

    if (rest === "" && m === "GET") return this.cond(c, this.repoJson(repo, login), login);

    if ((mm = /^\/git\/matching-refs\/(.*)$/.exec(rest)) && m === "GET") {
      const prefix = `refs/${decodeURIComponent(mm[1]!)}`;
      const list = [...repo.refs.entries()]
        .filter(([r]) => r.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([ref, sha]) => ({ ref, object: { sha, type: repo.tagObjects.has(sha) ? "tag" : "commit" } }));
      return this.paged(c, url, list, login);
    }
    if ((mm = /^\/git\/ref\/(.+)$/.exec(rest)) && m === "GET") {
      const ref = `refs/${decodeURIComponent(mm[1]!)}`;
      const sha = repo.refs.get(ref);
      if (!sha) return this.notFound();
      return this.cond(c, { ref, object: { sha, type: repo.tagObjects.has(sha) ? "tag" : "commit" } }, login);
    }
    if ((mm = /^\/git\/tags\/([0-9a-f]{40})$/.exec(rest)) && m === "GET") {
      const t = repo.tagObjects.get(mm[1]!);
      if (!t) return this.notFound();
      return this.cond(c, { sha: mm[1], tag: t.tag, message: t.message, object: { sha: t.object, type: "commit" } }, login);
    }
    if (rest === "/tags" && m === "GET") {
      const list = [...repo.refs.entries()]
        .filter(([r]) => r.startsWith("refs/tags/"))
        .map(([r, sha]) => ({ name: r.slice(10), commit: { sha: this.peel(repo, sha) } }));
      return this.paged(c, url, list, login);
    }
    if (rest === "/branches" && m === "GET") {
      const list = [...repo.refs.entries()].filter(([r]) => r.startsWith("refs/heads/")).map(([r, sha]) => ({ name: r.slice(11), commit: { sha } }));
      return this.paged(c, url, list, login);
    }
    if (rest === "/commits" && m === "GET") {
      const start = this.resolve(repo, url.searchParams.get("sha") ?? repo.defaultBranch);
      if (!start) return this.notFound();
      let list = this.walk(repo, start);
      const path = url.searchParams.get("path");
      if (path) list = list.filter((x) => this.filesFor(repo, x).some((f) => f.filename === path || f.previous_filename === path));
      return this.paged(
        c,
        url,
        list.map((x) => this.commitJson(repo, x)),
        login,
      );
    }
    if ((mm = /^\/commits\/(.+)$/.exec(rest)) && m === "GET") {
      const sha = this.resolve(repo, decodeURIComponent(mm[1]!));
      if (!sha) return this.json({ message: "No commit found for SHA" }, 422);
      return this.cond(c, this.commitJson(repo, repo.commits.get(sha)!, true), login);
    }
    if ((mm = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest)) && m === "GET") {
      const base = this.resolve(repo, decodeURIComponent(mm[1]!));
      const head = this.resolve(repo, decodeURIComponent(mm[2]!));
      if (!base || !head) return this.notFound();
      const ab = this.ancestors(repo, base);
      const ah = this.ancestors(repo, head);
      const ahead = [...ah].filter((x) => !ab.has(x));
      const behind = [...ab].filter((x) => !ah.has(x));
      // merge base: newest common ancestor
      let mb: string | null = null;
      for (const x of this.walk(repo, head)) if (ab.has(x.sha)) {
        mb = x.sha;
        break;
      }
      const real = (s: string) => repo.commits.get(s)?.real;
      const files = mb && repo.gitDir && real(mb) && real(head) ? this.diffFiles(repo.gitDir, mb, head) : [];
      return this.cond(
        c,
        {
          status: ahead.length && behind.length ? "diverged" : ahead.length ? "ahead" : behind.length ? "behind" : "identical",
          ahead_by: ahead.length,
          behind_by: behind.length,
          merge_base_commit: mb ? { sha: mb } : null,
          commits: ahead.map((s) => this.commitJson(repo, repo.commits.get(s)!)),
          files,
        },
        login,
      );
    }
    if ((mm = /^\/contents\/(.+)$/.exec(rest)) && m === "GET") {
      const path = decodeURIComponent(mm[1]!);
      const sha = this.resolve(repo, url.searchParams.get("ref") ?? repo.defaultBranch);
      if (!sha || !repo.gitDir) return this.notFound();
      const cm = repo.commits.get(sha)!;
      const tree = cm.real ? cm.sha : cm.treeOf;
      if (!tree) return this.notFound();
      let buf: Buffer;
      try {
        buf = gitBuf(repo.gitDir, ["show", `${tree}:${path}`]);
      } catch {
        return this.notFound();
      }
      return this.cond(c, { type: "file", path, name: path.split("/").pop(), size: buf.length, sha: createHash("sha1").update(buf).digest("hex"), encoding: "base64", content: buf.toString("base64").replace(/(.{60})/g, "$1\n") }, login);
    }

    // ---- writes ----
    if (rest === "/git/refs" && m === "POST") {
      if (!canPush) return forbidden();
      const b = await this.body(c);
      const ref = String(b.ref ?? "");
      const sha = String(b.sha ?? "");
      if (!/^refs\/(heads|tags)\/.+/.test(ref)) return this.json({ message: "Reference name is invalid" }, 422);
      if (repo.refs.has(ref)) return this.json({ message: "Reference already exists" }, 422);
      if (!repo.commits.has(sha) && !repo.tagObjects.has(sha)) return this.json({ message: "Object does not exist" }, 422);
      repo.refs.set(ref, sha);
      return this.json({ ref, object: { sha, type: repo.tagObjects.has(sha) ? "tag" : "commit" } }, 201);
    }
    if ((mm = /^\/git\/refs\/(.+)$/.exec(rest)) && (m === "DELETE" || m === "PATCH")) {
      if (!canPush) return forbidden();
      const ref = `refs/${decodeURIComponent(mm[1]!)}`;
      if (!repo.refs.has(ref)) return this.json({ message: "Reference does not exist" }, 422);
      if (m === "DELETE") {
        repo.refs.delete(ref);
        return new Response(null, { status: 204 });
      }
      const b = await this.body(c);
      repo.refs.set(ref, String(b.sha));
      return this.json({ ref, object: { sha: b.sha, type: "commit" } });
    }
    if (rest === "/git/tags" && m === "POST") {
      if (!canPush) return forbidden();
      const b = await this.body(c);
      const sha = createHash("sha1").update(`tag ${b.tag} ${b.object} ${randomBytes(4).toString("hex")}`).digest("hex");
      repo.tagObjects.set(sha, { tag: String(b.tag), message: String(b.message ?? ""), object: String(b.object) });
      return this.json({ sha, tag: b.tag, message: b.message, object: { sha: b.object, type: "commit" } }, 201);
    }
    if ((mm = /^\/branches\/(.+)\/rename$/.exec(rest)) && m === "POST") {
      if (!canPush) return forbidden();
      const from = `refs/heads/${decodeURIComponent(mm[1]!)}`;
      const b = await this.body(c);
      const to = `refs/heads/${String(b.new_name)}`;
      const sha = repo.refs.get(from);
      if (!sha) return this.notFound();
      if (repo.refs.has(to)) return this.json({ message: "New branch already exists" }, 422);
      repo.refs.delete(from);
      repo.refs.set(to, sha);
      if (repo.defaultBranch === from.slice(11)) repo.defaultBranch = to.slice(11);
      return this.json({ name: to.slice(11), commit: { sha } }, 201);
    }
    return this.notFound();
  }

  private async graphql(c: Context, login: string | null): Promise<Response> {
    if (!login) return this.json({ message: "This endpoint requires you to be authenticated." }, 401);
    const b = (await c.req.json()) as { query: string; variables: Record<string, string> };
    const v = b.variables;
    const repo = this.repos.get(`${v.owner}/${v.name}`.toLowerCase());
    if (!repo || !this.perm(repo, login)) return this.json({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] });
    if (b.query.includes("blame(")) {
      const sha = this.resolve(repo, v.expr!);
      if (!sha || !repo.gitDir) return this.json({ data: { repository: { object: null } } });
      const out = git(repo.gitDir, ["blame", "--porcelain", sha, "--", v.path!]);
      const lines: { line: number; sha: string }[] = [];
      const meta = new Map<string, { name: string; time: number }>();
      let cur: string | null = null;
      for (const l of out.split("\n")) {
        const h = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l);
        if (h) {
          cur = h[1]!;
          lines.push({ line: Number(h[2]), sha: cur });
          if (!meta.has(cur)) meta.set(cur, { name: "", time: 0 });
        } else if (cur && l.startsWith("author ")) meta.get(cur)!.name = l.slice(7);
        else if (cur && l.startsWith("author-time ")) meta.get(cur)!.time = Number(l.slice(12));
      }
      const ranges: unknown[] = [];
      for (let i = 0; i < lines.length; ) {
        let j = i;
        while (j + 1 < lines.length && lines[j + 1]!.sha === lines[i]!.sha && lines[j + 1]!.line === lines[j]!.line + 1) j++;
        const mt = meta.get(lines[i]!.sha)!;
        ranges.push({ startingLine: lines[i]!.line, endingLine: lines[j]!.line, commit: { oid: lines[i]!.sha, committedDate: iso(mt.time), author: { name: mt.name, date: iso(mt.time) } } });
        i = j + 1;
      }
      return this.json({ data: { repository: { object: { blame: { ranges } } } } });
    }
    return this.json({ errors: [{ message: "unsupported query in fake" }] });
  }
}
