// GitHub webhook receiver.
//  1. Verify X-Hub-Signature-256 (HMAC-SHA256 over the raw body, timing-safe) → 401 otherwise.
//  2. De-duplicate by X-GitHub-Delivery, durably: the id is appended to DATA_DIR before we ack.
//  3. Acknowledge fast (202) and process on an in-process queue with bounded exponential retry.
// Processing is idempotent and never applies payload state blindly: ref-affecting events trigger
// a reconciliation that re-reads authoritative refs from GitHub.

import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import { AppError, repoKey } from "../../core/types.ts";
import type { EventHub } from "../../core/sync/hub.ts";
import { errorResponse } from "../security.ts";
import type { Reconciler } from "./reconciler.ts";

export function verifySignature(secret: string, body: Uint8Array, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const got = Buffer.from(header.slice(7), "hex");
  const want = createHmac("sha256", secret).update(body).digest();
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Bounded, durable set of recently seen delivery ids. */
export class DeliveryLog {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];
  private readonly file: string | null;
  private readonly max: number;
  private appended = 0;

  constructor(dataDir: string | null, max = 10_000) {
    this.file = dataDir ? join(dataDir, "webhook-deliveries.log") : null;
    this.max = max;
    if (this.file) {
      try {
        const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
        for (const id of lines.slice(-max)) this.remember(id);
      } catch {
        /* first start */
      }
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  private remember(id: string) {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.order.push(id);
    while (this.order.length > this.max) this.ids.delete(this.order.shift()!);
  }

  /** Record the id; persisted synchronously so a crash after acking cannot reprocess it. */
  add(id: string) {
    this.remember(id);
    if (!this.file) return;
    mkdirSync(join(this.file, ".."), { recursive: true });
    appendFileSync(this.file, `${id}\n`);
    if (++this.appended > this.max) {
      this.appended = 0;
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, this.order.join("\n") + "\n");
      renameSync(tmp, this.file);
    }
  }

  get size(): number {
    return this.ids.size;
  }
}

interface Job {
  delivery: string;
  event: string;
  payload: Record<string, any>;
  attempts: number;
  receivedAt: number;
}

export interface WebhookOptions {
  secret: string | null;
  dataDir: string | null;
  hub: EventHub;
  reconciler: Reconciler;
  /** A repository's access changed (privatized, deleted, app removed): drop cached authorization. */
  onAccessChanged: (repo: string) => void;
  /** Activity on a repository (lets the poller restart its back-off). */
  onActivity?: (repo: string) => void;
  /** A user revoked the app: end their sessions and close their streams. */
  onUserRevoked: (userId: number, login: string) => void;
  log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
  maxAttempts?: number;
  retryBaseMs?: number;
  concurrency?: number;
  maxBodyBytes?: number;
}

export interface WebhookStats {
  received: number;
  rejected: number;
  duplicates: number;
  processed: number;
  failed: number;
  retried: number;
}

function repoOf(p: Record<string, any> | undefined): string | null {
  const r = p?.repository ?? p;
  const owner = r?.owner?.login ?? r?.owner?.name;
  const name = r?.name;
  if (typeof owner !== "string" || typeof name !== "string") {
    const full = r?.full_name;
    if (typeof full === "string" && full.includes("/")) {
      const [o, n] = full.split("/");
      return repoKey({ provider: "github", owner: o!, name: n! });
    }
    return null;
  }
  return repoKey({ provider: "github", owner, name });
}

export class Webhooks {
  readonly stats: WebhookStats = { received: 0, rejected: 0, duplicates: 0, processed: 0, failed: 0, retried: 0 };
  readonly deliveries: DeliveryLog;
  private readonly o: WebhookOptions;
  private readonly queue: Job[] = [];
  private active = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private idleWaiters: (() => void)[] = [];
  private closed = false;
  /** Receipt time of the latest delivery per repository (for latency measurement / status). */
  readonly lastReceipt = new Map<string, number>();

  constructor(o: WebhookOptions) {
    this.o = o;
    this.deliveries = new DeliveryLog(o.dataDir);
  }

  async handle(c: Context): Promise<Response> {
    if (!this.o.secret) return errorResponse(c, new AppError("UNSUPPORTED", "Webhooks are not configured (GITHUB_WEBHOOK_SECRET)"));
    const len = Number(c.req.header("content-length") ?? 0);
    const max = this.o.maxBodyBytes ?? 25 * 1024 * 1024; // GitHub caps payloads at 25 MB
    if (len > max) return errorResponse(c, new AppError("BAD_REQUEST", "Payload too large"));
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.length > max) return errorResponse(c, new AppError("BAD_REQUEST", "Payload too large"));
    if (!verifySignature(this.o.secret, body, c.req.header("x-hub-signature-256"))) {
      this.stats.rejected++;
      return errorResponse(c, new AppError("UNAUTHENTICATED", "Invalid webhook signature"));
    }
    this.stats.received++;
    const delivery = c.req.header("x-github-delivery") ?? "";
    const event = c.req.header("x-github-event") ?? "";
    if (!delivery || !/^[A-Za-z0-9-]{1,100}$/.test(delivery)) return errorResponse(c, new AppError("BAD_REQUEST", "Missing X-GitHub-Delivery"));
    if (this.deliveries.has(delivery)) {
      this.stats.duplicates++;
      return c.json({ ok: true, duplicate: true }, 200);
    }
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, any>;
    } catch {
      return errorResponse(c, new AppError("BAD_REQUEST", "Payload is not JSON"));
    }
    this.deliveries.add(delivery);
    const now = Date.now();
    const repo = repoOf(payload);
    if (repo) this.lastReceipt.set(repo, now);
    this.queue.push({ delivery, event, payload, attempts: 0, receivedAt: now });
    this.pump();
    return c.json({ ok: true, queued: true }, 202);
  }

  /** Resolves when the queue is empty and nothing is processing (tests). */
  idle(): Promise<void> {
    if (!this.queue.length && !this.active && !this.timers.size) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private checkIdle() {
    if (!this.queue.length && !this.active && !this.timers.size) {
      const w = this.idleWaiters;
      this.idleWaiters = [];
      for (const r of w) r();
    }
  }

  private pump() {
    // Jobs mostly wait on a coalesced reconciliation; a high limit lets a burst share one run.
    const conc = this.o.concurrency ?? 64;
    while (!this.closed && this.active < conc && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void this.run(job).finally(() => {
        this.active--;
        this.pump();
        this.checkIdle();
      });
    }
  }

  private async run(job: Job) {
    try {
      await this.process(job);
      this.stats.processed++;
    } catch (e) {
      const err = AppError.from(e);
      job.attempts++;
      const max = this.o.maxAttempts ?? 5;
      const transient = !["BAD_REQUEST", "NOT_FOUND", "UNSUPPORTED", "FORBIDDEN"].includes(err.code);
      if (transient && job.attempts < max && !this.closed) {
        this.stats.retried++;
        const delay = (this.o.retryBaseMs ?? 1000) * 2 ** (job.attempts - 1) * (0.75 + Math.random() * 0.5);
        const t = setTimeout(() => {
          this.timers.delete(t);
          this.queue.push(job);
          this.pump();
          this.checkIdle();
        }, delay);
        this.timers.add(t);
        this.o.log("warn", "webhook processing failed; will retry", { delivery: job.delivery, event: job.event, attempt: job.attempts, error: err.message });
      } else {
        this.stats.failed++;
        this.o.log("error", "webhook processing failed", { delivery: job.delivery, event: job.event, error: err.message });
      }
    }
  }

  /** Idempotent: every branch either re-reads authoritative state or publishes a deduplicated event. */
  private async process(job: Job): Promise<void> {
    const { event, payload } = job;
    const repo = repoOf(payload);
    const hub = this.o.hub;
    const reconcile = async (r: string) => {
      this.o.reconciler.noteWebhook(r);
      this.o.onActivity?.(r);
      await this.o.reconciler.request(r);
    };
    switch (event) {
      case "ping":
        return;
      case "push": {
        if (!repo) return;
        const ids: string[] = [];
        for (const c of (payload.commits ?? []) as { id?: string }[]) if (typeof c?.id === "string" && /^[0-9a-f]{40}$/.test(c.id)) ids.push(c.id);
        const after = payload.after;
        if (typeof after === "string" && /^[0-9a-f]{40}$/.test(after) && !/^0+$/.test(after) && !ids.includes(after)) ids.push(after);
        if (ids.length) hub.publish({ type: "commits.added", repositoryId: repo, commits: ids.slice(-500) }, `push:${job.delivery}`);
        await reconcile(repo);
        return;
      }
      case "create":
      case "delete":
        if (repo) await reconcile(repo);
        return;
      case "repository": {
        if (!repo) return;
        const action = payload.action as string;
        if (action === "privatized" || action === "deleted") {
          this.o.onAccessChanged(repo);
          hub.publish({ type: "access.revoked", repositoryId: repo }, `access:${job.delivery}`);
          this.o.reconciler.forget(repo);
          return;
        }
        if (action === "renamed") {
          const from = payload.changes?.repository?.name?.from;
          const owner = payload.repository?.owner?.login;
          if (typeof from === "string" && typeof owner === "string") {
            const old = repoKey({ provider: "github", owner, name: from });
            this.o.onAccessChanged(old);
            hub.publish({ type: "resync", repositoryId: old, reason: `repository renamed to ${payload.repository?.full_name ?? "a new name"}` }, `rename:${job.delivery}`);
          }
          return;
        }
        if (action === "transferred") {
          this.o.onAccessChanged(repo);
          hub.publish({ type: "access.revoked", repositoryId: repo }, `access:${job.delivery}`);
          return;
        }
        // publicized, edited (default branch), archived, unarchived: state changed; reconcile.
        this.o.onAccessChanged(repo);
        hub.publish({ type: "resync", repositoryId: repo, reason: `repository ${action}` }, `repo:${job.delivery}`);
        this.o.reconciler.forget(repo);
        await reconcile(repo);
        return;
      }
      case "installation":
      case "installation_repositories": {
        const action = payload.action as string;
        const removed: Record<string, any>[] =
          event === "installation"
            ? action === "deleted" || action === "suspend"
              ? (payload.repositories ?? [])
              : []
            : (payload.repositories_removed ?? []);
        const owner = payload.installation?.account?.login;
        for (const r of removed) {
          const k = typeof r.full_name === "string" ? repoOf({ full_name: r.full_name }) : owner && r.name ? repoKey({ provider: "github", owner, name: r.name }) : null;
          if (!k) continue;
          this.o.onAccessChanged(k);
          hub.publish({ type: "access.revoked", repositoryId: k }, `access:${job.delivery}:${k}`);
          this.o.reconciler.forget(k);
        }
        const added: Record<string, any>[] = event === "installation" ? (action === "created" || action === "unsuspend" ? (payload.repositories ?? []) : []) : (payload.repositories_added ?? []);
        for (const r of added) {
          const k = typeof r.full_name === "string" ? repoOf({ full_name: r.full_name }) : null;
          if (k) this.o.reconciler.noteWebhook(k);
        }
        return;
      }
      case "github_app_authorization": {
        if (payload.action === "revoked" && typeof payload.sender?.id === "number") this.o.onUserRevoked(payload.sender.id, String(payload.sender.login ?? ""));
        return;
      }
      default:
        return;
    }
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.queue.length = 0;
    this.checkIdle();
  }
}
