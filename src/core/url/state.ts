// URL <-> view state. The URL is the canonical source for shareable navigation state.
// Pure: no DOM access. Parsing is total: invalid input degrades to defaults with warnings.

import type { CommitOrder, RepoRef } from "../types.ts";

export type ViewMode = "graph" | "details" | "diff";

export interface DisplayPrefs {
  remotes: boolean;
  tags: boolean;
  stashes: boolean;
  order: CommitOrder;
  firstParent: boolean;
}

export const DEFAULT_DISPLAY: DisplayPrefs = { remotes: true, tags: true, stashes: true, order: "date", firstParent: false };

/** Pseudo-commit id for the uncommitted-changes row. */
export const WORKING = "working";

export interface ViewState {
  repo: RepoRef | null;
  /** Worktree path (local provider only). */
  worktree: string | null;
  /** Branch filter; empty = show all branches. */
  branches: string[];
  /** Branch whose lane is emphasised. */
  focusBranch: string | null;
  /** Primary selected commit (hash, or WORKING). */
  commit: string | null;
  /** Additional selected commits (multi-select), excluding `commit`. */
  selected: string[];
  /** Compare target: details show the diff between `commit` and `compare`. */
  compare: string | null;
  view: ViewMode;
  file: string | null;
  q: string;
  display: DisplayPrefs;
  /** History anchor: hash of the row at the top of the viewport. */
  at: string | null;
}

export const EMPTY_VIEW: ViewState = {
  repo: null,
  worktree: null,
  branches: [],
  focusBranch: null,
  commit: null,
  selected: [],
  compare: null,
  view: "graph",
  file: null,
  q: "",
  display: DEFAULT_DISPLAY,
  at: null,
};

const HASH_RE = /^[0-9a-f]{4,64}$/;
// GitHub owner/repo names: alnum, -, _, . (no leading dot for repos is not enforced by GitHub for owner).
const GH_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Conservative ref-name validation (subset of git check-ref-format). */
export function isValidRefName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{") || name === "@") return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return true;
}

export function normalizeHash(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (s === WORKING) return WORKING;
  return HASH_RE.test(s) ? s : null;
}

function bool(v: string | null, dflt: boolean): boolean {
  if (v === null) return dflt;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return dflt;
}

export interface ParseResult {
  state: ViewState;
  warnings: string[];
}

/** Parse a GitHub web URL or "owner/repo" shorthand into a RepoRef plus optional commit/branch hints. */
export function parseGitHubInput(input: string): { repo: RepoRef; commit?: string; branch?: string; compare?: [string, string] } | null {
  const s = input.trim();
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(s);
  if (short && GH_NAME_RE.test(short[1]!) && GH_NAME_RE.test(short[2]!)) {
    return { repo: { provider: "github", owner: short[1]!, name: short[2]! } };
  }
  let url: URL;
  try {
    url = new URL(s.replace(/^git@github\.com:/, "https://github.com/"));
  } catch {
    return null;
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const seg = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (seg.length < 2) return null;
  const owner = seg[0]!;
  const name = seg[1]!.replace(/\.git$/, "");
  if (!GH_NAME_RE.test(owner) || !GH_NAME_RE.test(name)) return null;
  const repo: RepoRef = { provider: "github", owner, name };
  if (seg[2] === "commit" && seg[3] && normalizeHash(seg[3])) return { repo, commit: normalizeHash(seg[3])! };
  if (seg[2] === "tree" && seg.length > 3) return { repo, branch: seg.slice(3).join("/") };
  if (seg[2] === "compare" && seg[3]) {
    const m = /^(.+?)\.{2,3}(.+)$/.exec(seg.slice(3).join("/"));
    if (m) return { repo, compare: [m[1]!, m[2]!] };
  }
  return { repo };
}

export function parseUrl(input: URL | string): ParseResult {
  const url = typeof input === "string" ? new URL(input, "http://x") : input;
  const p = url.searchParams;
  const warnings: string[] = [];
  const state: ViewState = { ...EMPTY_VIEW, display: { ...DEFAULT_DISPLAY }, branches: [], selected: [] };

  // --- repository: path form first, then ?repo= / ?provider= query form
  const seg = url.pathname.split("/").filter(Boolean).map((x) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  });
  if (seg[0] === "github" && seg.length >= 3) {
    if (GH_NAME_RE.test(seg[1]!) && GH_NAME_RE.test(seg[2]!)) state.repo = { provider: "github", owner: seg[1]!, name: seg[2]! };
    else warnings.push(`Invalid GitHub repository "${seg[1]}/${seg[2]}"`);
  } else if ((seg[0] === "local" || seg[0] === "browser") && seg[1]) {
    if (ID_RE.test(seg[1])) state.repo = { provider: seg[0], id: seg[1] } as RepoRef;
    else warnings.push(`Invalid ${seg[0]} repository id`);
  } else if (p.get("repo")) {
    const provider = p.get("provider") ?? "github";
    const r = p.get("repo")!;
    if (provider === "github") {
      const gh = parseGitHubInput(r);
      if (gh) state.repo = gh.repo;
      else warnings.push(`Invalid GitHub repository "${r}"`);
    } else if ((provider === "local" || provider === "browser") && ID_RE.test(r)) {
      state.repo = { provider, id: r } as RepoRef;
    } else warnings.push(`Unsupported provider "${provider}"`);
  }

  const wt = p.get("worktree");
  if (wt) {
    if (state.repo?.provider === "local") state.worktree = wt;
    else warnings.push("worktree applies only to local repositories");
  }

  // --- branch filter (repeatable or comma separated)
  const branches = p.getAll("branch").flatMap((b) => b.split(",")).map((b) => b.trim()).filter(Boolean);
  for (const b of branches) {
    if (isValidRefName(b)) {
      if (!state.branches.includes(b)) state.branches.push(b);
    } else warnings.push(`Ignored invalid branch "${b}"`);
  }
  const focus = p.get("focus-branch");
  if (focus) {
    if (isValidRefName(focus)) state.focusBranch = focus;
    else warnings.push(`Ignored invalid focus-branch "${focus}"`);
  }

  // --- selection and comparison
  const commitRaw = p.get("commit");
  const compareRaw = p.get("compare");
  if (compareRaw && /\.{2,3}/.test(compareRaw)) {
    const [a, b] = compareRaw.split(/\.{2,3}/);
    const ha = normalizeHash(a);
    const hb = normalizeHash(b);
    if (ha && hb) {
      state.commit = ha;
      state.compare = hb;
    } else warnings.push(`Ignored invalid compare "${compareRaw}"`);
  } else {
    if (commitRaw) {
      state.commit = normalizeHash(commitRaw);
      if (!state.commit) warnings.push(`Ignored invalid commit "${commitRaw}"`);
    }
    if (compareRaw) {
      const h = normalizeHash(compareRaw);
      if (h && state.commit && h !== state.commit) state.compare = h;
      else if (h && !state.commit) warnings.push("compare requires commit");
      else if (!h) warnings.push(`Ignored invalid compare "${compareRaw}"`);
    }
  }
  const sel = p.getAll("select").flatMap((s) => s.split(","));
  for (const s of sel) {
    const h = normalizeHash(s);
    if (h && h !== state.commit && !state.selected.includes(h)) state.selected.push(h);
    else if (!h && s.trim()) warnings.push(`Ignored invalid selection "${s}"`);
  }

  const view = p.get("view");
  const file = p.get("file");
  if (file && !file.includes("\0") && file.length < 4096) state.file = file.replace(/^\/+/, "");
  if (view === "graph" || view === "details" || view === "diff") state.view = view;
  else if (view) warnings.push(`Unknown view "${view}"`);
  else if (state.commit) state.view = state.file ? "diff" : "details";
  if (state.view !== "graph" && !state.commit) {
    warnings.push(`view=${state.view} requires commit`);
    state.view = "graph";
  }
  if (state.view === "diff" && !state.file) state.view = "details";

  state.q = (p.get("q") ?? "").slice(0, 200);

  state.display.remotes = bool(p.get("remotes"), true);
  state.display.tags = bool(p.get("tags"), true);
  state.display.stashes = bool(p.get("stashes"), true);
  state.display.firstParent = bool(p.get("first-parent"), false);
  const order = p.get("order");
  if (order === "date" || order === "topo" || order === "author-date") state.display.order = order;
  else if (order) warnings.push(`Unknown order "${order}"`);

  const at = p.get("at");
  if (at) {
    state.at = normalizeHash(at);
    if (!state.at || state.at === WORKING) {
      state.at = null;
      warnings.push(`Ignored invalid at "${at}"`);
    }
  }
  if (!state.repo) {
    // Nothing else is meaningful without a repository.
    return { state: { ...EMPTY_VIEW, display: state.display }, warnings };
  }
  return { state, warnings };
}

export function repoPath(r: RepoRef): string {
  switch (r.provider) {
    case "github":
      return `/github/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
    case "local":
      return `/local/${r.id}`;
    case "browser":
      return `/browser/${r.id}`;
  }
}

/** Canonical path+query for a state (stable parameter order, defaults omitted). */
export function serialize(state: ViewState): string {
  if (!state.repo) return "/";
  const q: [string, string][] = [];
  if (state.worktree && state.repo.provider === "local") q.push(["worktree", state.worktree]);
  for (const b of state.branches) q.push(["branch", b]);
  if (state.focusBranch) q.push(["focus-branch", state.focusBranch]);
  if (state.commit) q.push(["commit", state.commit]);
  if (state.commit && state.compare) q.push(["compare", state.compare]);
  if (state.selected.length) q.push(["select", state.selected.join(",")]);
  if (state.commit) {
    const implied = state.file ? "diff" : "details";
    if (state.view !== implied) q.push(["view", state.view]);
    if (state.file && state.view !== "graph") q.push(["file", state.file]);
  }
  if (state.q) q.push(["q", state.q]);
  const d = state.display;
  if (!d.remotes) q.push(["remotes", "0"]);
  if (!d.tags) q.push(["tags", "0"]);
  if (!d.stashes) q.push(["stashes", "0"]);
  if (d.order !== "date") q.push(["order", d.order]);
  if (d.firstParent) q.push(["first-parent", "1"]);
  if (state.at) q.push(["at", state.at]);
  const qs = q.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2F/g, "/").replace(/%2C/g, ",")}`).join("&");
  return repoPath(state.repo) + (qs ? `?${qs}` : "");
}

export function buildUrl(origin: string, state: ViewState): string {
  return origin.replace(/\/+$/, "") + serialize(state);
}

/** True when two states describe the same shareable view. */
export function sameView(a: ViewState, b: ViewState): boolean {
  return serialize(a) === serialize(b);
}

/** Navigation entries that should push history vs replace (e.g. scrolling `at` replaces). */
export function shouldPush(prev: ViewState, next: ViewState): boolean {
  const strip = (s: ViewState) => serialize({ ...s, at: null, q: "" });
  return strip(prev) !== strip(next);
}
