// Security headers, CSRF origin checks, client IP resolution and token-bucket rate limiting.

import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { AppError, HTTP_STATUS } from "../core/types.ts";

export function securityHeaders(appOrigin: string): MiddlewareHandler {
  const https = appOrigin.startsWith("https://");
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // Solid/Tailwind set inline style attributes for virtualized rows and graph lanes.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://avatars.githubusercontent.com https://*.githubusercontent.com https://*.googleusercontent.com", // GitHub and Google (relay sign-in) avatars
    "font-src 'self' data:",
    // The local CLI companion listens on loopback.
    "connect-src 'self' http://127.0.0.1:* http://localhost:*",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    const set = (k: string, v: string) => {
      try {
        h.set(k, v);
      } catch {
        /* immutable headers (e.g. a proxied Response): rebuild */
        c.res = new Response(c.res.body, c.res);
        c.res.headers.set(k, v);
      }
    };
    set("Content-Security-Policy", csp);
    set("X-Content-Type-Options", "nosniff");
    set("Referrer-Policy", "no-referrer");
    set("X-Frame-Options", "DENY");
    set("Cross-Origin-Opener-Policy", "same-origin");
    set("Cross-Origin-Resource-Policy", "same-origin");
    set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()");
    if (https) set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  };
}

export function errorResponse(c: Context, e: AppError, headers: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.json({ error: e.toJSON() }, (HTTP_STATUS[e.code] ?? 500) as 400);
}

/**
 * CSRF for state-changing requests: the browser must prove same-origin via Origin, or (when the
 * Origin header is absent) Sec-Fetch-Site: same-origin. Non-browser clients without either are
 * rejected too: the hosted API is cookie-authenticated, so there is no header-token path to allow.
 */
export function csrfGuard(appOrigin: string): MiddlewareHandler {
  return async (c, next) => {
    const m = c.req.method;
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    const ok = origin ? origin === appOrigin : site === "same-origin";
    if (!ok) return errorResponse(c, new AppError("FORBIDDEN", "Cross-site request rejected (Origin does not match this app)"));
    return next();
  };
}

/** Client IP: the socket address, or the X-Forwarded-For entry `trustProxy` hops from the right. */
export function clientIp(c: Context, trustProxy: number): string {
  if (trustProxy > 0) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      const ip = parts[Math.max(0, parts.length - trustProxy)];
      if (ip) return ip;
    }
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  readonly capacity: number;
  readonly refillPerSec: number;
  private readonly now: () => number;
  constructor(capacity: number, refillPerSec: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
  }
  /** Take one token; returns 0 when allowed, else seconds until a token is available. */
  take(key: string): number {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, at: t };
      this.buckets.set(key, b);
      if (this.buckets.size > 50_000) this.prune();
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / Math.max(this.refillPerSec, 1e-6)));
  }
  private prune() {
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.at) / 1000) * this.refillPerSec >= this.capacity) this.buckets.delete(k);
    }
  }
}

export function rateLimit(buckets: TokenBuckets, keyOf: (c: Context) => string, scope: string): MiddlewareHandler {
  return async (c, next) => {
    const wait = buckets.take(`${scope}:${keyOf(c)}`);
    if (wait > 0) {
      return errorResponse(c, new AppError("RATE_LIMITED", `Too many requests; retry in ${wait}s`, { retryAfter: wait }), { "Retry-After": String(wait) });
    }
    return next();
  };
}
