// The UI's view of the single command registry.
//  - Repo commands (queries/mutations) come from core/commands/repo-commands.ts unchanged; the UI
//    never re-implements them: mutations are executed by the host that owns the adapter (hosted
//    server or local companion) through /api/v1/commands/execute, which enforces validation,
//    capabilities and the destructive-confirmation policy.
//  - UI commands (navigation, view, palette…) are registered in the same registry.
//  - Binders map the current context (focused commit / ref / file / hunk) to command arguments and
//    describe which arguments still need to be asked for.

import { z } from "zod";
import { CommandRegistry, defineCommand, type AnyCommand, type MenuContext } from "../../core/commands/registry.ts";
import { repoCommands } from "../../core/commands/repo-commands.ts";
import { AppError, type MutationResult, type Ref, type Worktree, type Remote, type RepoInfo } from "../../core/types.ts";
import { buildUrl, parseGitHubInput, WORKING, type ViewState } from "../../core/url/state.ts";
import { app, type DialogField, type MenuItem } from "./store.ts";
import type { RowCommit } from "../engine/protocol.ts";
import { isReserved } from "./platform.ts";
import { fsAccessSupported, newHandleId, saveHandle } from "./handles.ts";

export interface UiContext {
  commit: RowCommit | null;
  ref: Ref | null;
  file: { path: string; area: "commit" | "staged" | "unstaged" | "untracked" | "conflicted" } | null;
  hunk: { patch: string; staged: boolean; path: string } | null;
  worktree: Worktree | null;
}

export type Scope = "global" | "graph" | "details" | "diff";

type UiCommand = AnyCommand & { scope?: Scope };

const noArgs = z.object({});

function short(h: string) {
  return h.slice(0, 8);
}

export function currentContext(): UiContext {
  const commit = app.rows.commits[app.kbRow()] ?? null;
  const refs = commit ? (app.refsByCommit().get(commit.hash) ?? []) : [];
  const rc = app.refCursor();
  return { commit, ref: rc >= 0 ? (refs[rc] ?? null) : null, file: null, hunk: null, worktree: null };
}

function describeTarget(ctx: UiContext): string {
  if (ctx.hunk) return `hunk in ${ctx.hunk.path}`;
  if (ctx.file) return ctx.file.path;
  if (ctx.ref) return ctx.ref.short;
  if (ctx.worktree) return ctx.worktree.path;
  if (ctx.commit) return ctx.commit.hash === WORKING ? "Uncommitted Changes" : `${short(ctx.commit.hash)} ${ctx.commit.subject}`;
  return "";
}

function stashIndex(r: Ref): number {
  return Number(/\{(\d+)\}/.exec(r.short)?.[1] ?? 0);
}

function remoteBranchName(r: Ref) {
  return r.remote ? r.short.slice(r.remote.length + 1) : r.short;
}

function isCurrentBranch(r: Ref | null) {
  return !!r && r.kind === "head" && r.short === app.headBranch();
}

// ---------------------------------------------------------------------------
// Binders: context → arguments (+ fields to ask). Return a string to say why it is unavailable.
// ---------------------------------------------------------------------------

interface Binder {
  label?: (ctx: UiContext) => string;
  contexts: MenuContext[] | "global";
  bind: (ctx: UiContext) => Record<string, unknown> | string;
  fields?: (ctx: UiContext, args: Record<string, unknown>) => DialogField[] | Promise<DialogField[]>;
  /** Map dialog values to args. */
  finish?: (args: Record<string, unknown>, v: Record<string, string | boolean>) => Record<string, unknown> | string;
}

async function remotesList(): Promise<Remote[]> {
  return (await portCall<Remote[]>("remotes", []).catch(() => [])) ?? [];
}

const needCommit = "Focus a commit first";
const needRef = (k: string) => `Focus a ${k} label first (←/→ on a row)`;

export const BINDERS: Record<string, Binder> = {
  "git.checkout": {
    label: (c) => (c.ref ? `Checkout ${c.ref.kind === "remote" ? "remote branch" : c.ref.kind === "tag" ? "tag" : "branch"} ${c.ref.short}` : "Checkout commit (detached)"),
    contexts: ["ref", "commit"],
    bind: (c) => {
      if (c.ref) {
        if (c.ref.kind === "stash") return "Stashes cannot be checked out";
        if (isCurrentBranch(c.ref)) return `${c.ref.short} is already checked out`;
        if (c.ref.kind === "head" && c.ref.checkedOutAt) return `${c.ref.short} is checked out in another worktree (${c.ref.checkedOutAt}). Use “Open worktree”.`;
        return c.ref.kind === "remote" ? { target: c.ref.short, track: true } : { target: c.ref.short };
      }
      if (!c.commit || c.commit.hash === WORKING) return needCommit;
      return { target: c.commit.hash };
    },
  },
  "git.branch.create": {
    contexts: ["commit", "ref"],
    bind: (c) => (c.commit && c.commit.hash !== WORKING ? { target: c.commit.hash } : needCommit),
    fields: () => [
      { name: "name", label: "Branch name", type: "text", required: true, placeholder: "feature/my-change" },
      { name: "checkout", label: "Check out", type: "checkbox", value: false },
    ],
  },
  "git.branch.delete": {
    label: (c) => (c.ref?.kind === "remote" ? `Delete remote branch ${c.ref.short}` : `Delete branch ${c.ref?.short ?? ""}`),
    contexts: ["ref"],
    bind: (c) => {
      if (!c.ref || (c.ref.kind !== "head" && c.ref.kind !== "remote")) return needRef("branch");
      if (isCurrentBranch(c.ref)) return "Cannot delete the checked-out branch";
      return c.ref.kind === "remote" ? { name: c.ref.short, remote: true } : { name: c.ref.short };
    },
    fields: (c) => (c.ref?.kind === "head" ? [{ name: "force", label: "Force delete (even if not merged)", type: "checkbox", value: false }] : []),
  },
  "git.branch.rename": {
    contexts: ["ref"],
    bind: (c) => (c.ref?.kind === "head" ? { from: c.ref.short } : needRef("local branch")),
    fields: (c) => [{ name: "to", label: "New name", type: "text", value: c.ref?.short ?? "", required: true }],
  },
  "git.tag.create": {
    contexts: ["commit"],
    bind: (c) => (c.commit && c.commit.hash !== WORKING ? { target: c.commit.hash } : needCommit),
    fields: () => [
      { name: "name", label: "Tag name", type: "text", required: true },
      { name: "message", label: "Message (annotated tag when set)", type: "textarea", placeholder: "Optional" },
    ],
    finish: (a, v) => ({ ...a, name: v.name, message: v.message ? String(v.message) : undefined }),
  },
  "git.tag.delete": { contexts: ["ref"], bind: (c) => (c.ref?.kind === "tag" ? { name: c.ref.short } : needRef("tag")) },
  "git.tag.push": {
    contexts: ["ref"],
    bind: (c) => (c.ref?.kind === "tag" ? { name: c.ref.short } : needRef("tag")),
    fields: async () => {
      const rs = await remotesList();
      return [{ name: "remote", label: "Remote", type: "select", options: rs.map((r) => ({ value: r.name, label: r.name })), value: rs[0]?.name ?? "origin" }];
    },
  },
  "git.merge": {
    label: (c) => `Merge ${c.ref?.short ?? (c.commit ? short(c.commit.hash) : "")} into ${app.headBranch() ?? "HEAD"}`,
    contexts: ["ref", "commit"],
    bind: (c) => (c.ref && c.ref.kind !== "stash" ? (isCurrentBranch(c.ref) ? "Cannot merge a branch into itself" : { ref: c.ref.short }) : c.commit && c.commit.hash !== WORKING ? { ref: c.commit.hash } : needCommit),
    fields: () => [
      { name: "noFastForward", label: "Create a new commit even if fast-forward is possible", type: "checkbox", value: true },
      { name: "squash", label: "Squash commits", type: "checkbox", value: false },
      { name: "noCommit", label: "No commit", type: "checkbox", value: false },
    ],
  },
  "git.rebase": {
    label: (c) => `Rebase ${app.headBranch() ?? "HEAD"} onto ${c.ref?.short ?? (c.commit ? short(c.commit.hash) : "")}`,
    contexts: ["ref", "commit"],
    bind: (c) => (c.ref && c.ref.kind !== "stash" ? (isCurrentBranch(c.ref) ? "Cannot rebase a branch onto itself" : { onto: c.ref.short }) : c.commit && c.commit.hash !== WORKING ? { onto: c.commit.hash } : needCommit),
  },
  "git.cherry-pick": {
    label: () => {
      const n = 1 + app.view().selected.length;
      return n > 1 && app.view().commit ? `Cherry-pick ${n} selected commits` : "Cherry-pick";
    },
    contexts: ["commit"],
    bind: (c) => {
      if (!c.commit || c.commit.hash === WORKING) return needCommit;
      const v = app.view();
      const sel = v.commit && (v.selected.length || v.commit !== c.commit.hash) ? [v.commit, ...v.selected] : [c.commit.hash];
      // Apply oldest first, in graph order.
      const hashes = [...new Set(sel)].sort((a, b) => (app.rows.index.get(b) ?? 0) - (app.rows.index.get(a) ?? 0));
      return { hashes };
    },
    fields: (c) => [
      { name: "recordOrigin", label: 'Record origin ("cherry picked from…")', type: "checkbox", value: false },
      { name: "noCommit", label: "No commit", type: "checkbox", value: false },
      ...(c.commit && c.commit.parents.length > 1 ? [{ name: "mainline", label: "Mainline parent", type: "select" as const, options: c.commit.parents.map((p, i) => ({ value: String(i + 1), label: `${i + 1}: ${short(p)}` })), value: "1" }] : []),
    ],
    finish: (a, v) => ({ ...a, recordOrigin: v.recordOrigin, noCommit: v.noCommit, mainline: v.mainline ? Number(v.mainline) : undefined }),
  },
  "git.revert": {
    contexts: ["commit"],
    bind: (c) => (c.commit && c.commit.hash !== WORKING ? { hash: c.commit.hash } : needCommit),
    fields: (c) =>
      c.commit && c.commit.parents.length > 1
        ? [{ name: "mainline", label: "Mainline parent", type: "select", options: c.commit.parents.map((p, i) => ({ value: String(i + 1), label: `${i + 1}: ${short(p)}` })), value: "1" }]
        : [],
    finish: (a, v) => ({ ...a, mainline: v.mainline ? Number(v.mainline) : undefined }),
  },
  "git.reset": {
    label: (c) => `Reset ${app.headBranch() ?? "HEAD"} to ${c.commit ? short(c.commit.hash) : ""}`,
    contexts: ["commit"],
    bind: (c) => (c.commit && c.commit.hash !== WORKING ? { target: c.commit.hash } : needCommit),
    fields: () => [
      {
        name: "mode",
        label: "Mode",
        type: "select",
        value: "mixed",
        options: [
          { value: "soft", label: "Soft — keep all changes staged" },
          { value: "mixed", label: "Mixed — keep changes in the working tree, unstaged" },
          { value: "hard", label: "Hard — discard all changes" },
        ],
      },
    ],
  },
  "git.operation.continue": { contexts: "global", bind: () => (app.repo.status?.operation ? {} : "No merge, rebase, cherry-pick or revert is in progress") },
  "git.operation.skip": { contexts: "global", bind: () => (app.repo.status?.operation ? {} : "No operation is in progress") },
  "git.operation.abort": { contexts: "global", bind: () => (app.repo.status?.operation ? {} : "No operation is in progress") },
  "git.stage": {
    contexts: ["file"],
    bind: (c) => (c.file && (c.file.area === "unstaged" || c.file.area === "untracked" || c.file.area === "conflicted") ? { paths: [c.file.path] } : "Focus an unstaged file"),
  },
  "git.unstage": { contexts: ["file"], bind: (c) => (c.file?.area === "staged" ? { paths: [c.file.path] } : "Focus a staged file") },
  "git.stage.patch": {
    label: (c) => (c.hunk?.staged ? "Unstage hunk" : "Stage hunk"),
    contexts: ["diff"],
    bind: (c) => (c.hunk ? { patch: c.hunk.patch, reverse: c.hunk.staged } : "Focus a hunk of an uncommitted diff"),
  },
  "git.discard.patch": { contexts: ["diff"], bind: (c) => (c.hunk && !c.hunk.staged ? { patch: c.hunk.patch } : "Focus an unstaged hunk") },
  "git.restore": {
    label: (c) => `Discard changes to ${c.file?.path ?? "file"}`,
    contexts: ["file"],
    bind: (c) => (c.file?.area === "unstaged" ? { paths: [c.file.path], worktree: true } : "Focus an unstaged file"),
  },
  "git.commit": {
    contexts: ["uncommitted"],
    bind: () => {
      const s = app.repo.status;
      if (!s) return "Working tree status is not available";
      return {};
    },
    fields: () => [
      { name: "message", label: "Commit message", type: "textarea", required: false, placeholder: "Summary line\n\nDetails" },
      { name: "amend", label: "Amend the last commit", type: "checkbox", value: false },
      { name: "signoff", label: "Add Signed-off-by", type: "checkbox", value: false },
    ],
    finish: (a, v) => {
      if (!v.amend && !String(v.message ?? "").trim()) return "A commit message is required";
      if (!v.amend && !app.repo.status?.staged.length) return "Nothing is staged. Stage files or hunks first.";
      return { ...a, message: String(v.message ?? ""), amend: v.amend, signoff: v.signoff };
    },
  },
  "git.stash.push": {
    label: () => "Stash uncommitted changes",
    contexts: ["uncommitted"],
    bind: () => (app.repo.status ? {} : "Working tree status is not available"),
    fields: () => {
      const s = app.repo.status!;
      const paths = [...new Set([...s.staged, ...s.unstaged].map((f) => f.path).concat(s.untracked))];
      return [
        { name: "message", label: "Message", type: "text", placeholder: "Optional" },
        { name: "includeUntracked", label: "Include untracked files", type: "checkbox", value: true },
        { name: "staged", label: "Only staged changes", type: "checkbox", value: false },
        { name: "paths", label: "Paths to stash (one per line; leave all to stash everything)", type: "textarea", value: paths.join("\n") },
      ];
    },
    finish: (a, v) => {
      const s = app.repo.status!;
      const all = new Set([...s.staged, ...s.unstaged].map((f) => f.path).concat(s.untracked));
      const chosen = String(v.paths ?? "")
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      const subset = chosen.length && chosen.length < all.size ? chosen : undefined;
      return { ...a, message: v.message ? String(v.message) : undefined, includeUntracked: v.includeUntracked, staged: v.staged || undefined, paths: subset };
    },
  },
  "git.stash.apply": { contexts: ["stash"], bind: (c) => (c.ref?.kind === "stash" ? { index: stashIndex(c.ref) } : needRef("stash")), fields: () => [{ name: "reinstateIndex", label: "Reinstate index", type: "checkbox", value: false }] },
  "git.stash.pop": { contexts: ["stash"], bind: (c) => (c.ref?.kind === "stash" ? { index: stashIndex(c.ref) } : needRef("stash")), fields: () => [{ name: "reinstateIndex", label: "Reinstate index", type: "checkbox", value: false }] },
  "git.stash.drop": { contexts: ["stash"], bind: (c) => (c.ref?.kind === "stash" ? { index: stashIndex(c.ref) } : needRef("stash")) },
  "git.stash.branch": {
    contexts: ["stash"],
    bind: (c) => (c.ref?.kind === "stash" ? { index: stashIndex(c.ref) } : needRef("stash")),
    fields: () => [{ name: "name", label: "Branch name", type: "text", required: true }],
  },
  "git.fetch": {
    contexts: "global",
    bind: () => ({}),
    fields: async () => {
      const rs = await remotesList();
      return [
        { name: "remote", label: "Remote", type: "select", value: "", options: [{ value: "", label: "All remotes" }, ...rs.map((r) => ({ value: r.name, label: r.name }))] },
        { name: "prune", label: "Prune deleted remote branches", type: "checkbox", value: false },
      ];
    },
    finish: (a, v) => ({ ...a, remote: v.remote ? String(v.remote) : undefined, prune: v.prune }),
  },
  "git.pull": {
    label: () => `Pull into ${app.headBranch() ?? "HEAD"}`,
    contexts: "global",
    bind: () => (app.headBranch() ? {} : "Check out a branch first"),
    fields: () => [
      { name: "ffOnly", label: "Fast-forward only", type: "checkbox", value: false },
      { name: "rebase", label: "Rebase instead of merge", type: "checkbox", value: false },
    ],
  },
  "git.push": {
    label: (c) => `Push ${c.ref?.kind === "head" ? c.ref.short : (app.headBranch() ?? "")}`,
    contexts: ["ref"],
    bind: (c) => {
      const b = c.ref?.kind === "head" ? c.ref : null;
      const name = b?.short ?? app.headBranch();
      return name ? { branch: name } : "Focus a local branch or check one out";
    },
    fields: async (c, a) => {
      const rs = await remotesList();
      const ref = app.repo.refs?.refs.find((r) => r.kind === "head" && r.short === a.branch);
      const upstreamRemote = ref?.upstream?.split("/")[2];
      return [
        { name: "remote", label: "Remote", type: "select", options: rs.map((r) => ({ value: r.name, label: r.name })), value: upstreamRemote ?? rs[0]?.name ?? "origin" },
        { name: "setUpstream", label: "Set upstream", type: "checkbox", value: !ref?.upstream },
        { name: "force", label: "Force push (always --force-with-lease)", type: "checkbox", value: false },
      ];
    },
    finish: (a, v) => {
      const remote = String(v.remote);
      const tracking = app.repo.refs?.refs.find((r) => r.kind === "remote" && r.short === `${remote}/${a.branch}`);
      return { branch: a.branch, remote, setUpstream: v.setUpstream, forceWithLease: v.force ? { expect: tracking?.commit } : undefined };
    },
  },
  "git.remote.add": {
    contexts: "global",
    bind: () => ({}),
    fields: () => [
      { name: "name", label: "Name", type: "text", required: true, value: "origin" },
      { name: "url", label: "URL", type: "text", required: true },
    ],
  },
  "git.remote.remove": {
    contexts: "global",
    bind: () => ({}),
    fields: async () => [{ name: "name", label: "Remote", type: "select", options: (await remotesList()).map((r) => ({ value: r.name, label: `${r.name} — ${r.fetchUrl}` })) }],
  },
  "git.remote.rename": {
    contexts: "global",
    bind: () => ({}),
    fields: async () => [
      { name: "from", label: "Remote", type: "select", options: (await remotesList()).map((r) => ({ value: r.name, label: r.name })) },
      { name: "to", label: "New name", type: "text", required: true },
    ],
  },
  "git.remote.set-url": {
    contexts: "global",
    bind: () => ({}),
    fields: async () => [
      { name: "name", label: "Remote", type: "select", options: (await remotesList()).map((r) => ({ value: r.name, label: `${r.name} — ${r.fetchUrl}` })) },
      { name: "url", label: "New URL", type: "text", required: true },
    ],
  },
  "git.upstream.set": {
    contexts: ["ref"],
    bind: (c) => (c.ref?.kind === "head" ? { branch: c.ref.short } : needRef("local branch")),
    fields: (c) => [
      {
        name: "upstream",
        label: "Upstream",
        type: "select",
        value: c.ref?.upstream?.replace(/^refs\/remotes\//, "") ?? "",
        options: [{ value: "", label: "(none — unset upstream)" }, ...(app.repo.refs?.refs ?? []).filter((r) => r.kind === "remote" && !r.symbolicTarget).map((r) => ({ value: r.short, label: r.short }))],
      },
    ],
    finish: (a, v) => ({ ...a, upstream: v.upstream ? String(v.upstream) : null }),
  },
  "git.worktree.add": {
    label: (c) => (c.ref?.kind === "head" ? `Create worktree for ${c.ref.short}` : "Create worktree…"),
    contexts: ["ref", "commit"],
    bind: (c) => {
      if (c.ref?.kind === "head") return c.ref.checkedOutAt || isCurrentBranch(c.ref) ? `${c.ref.short} is already checked out${c.ref.checkedOutAt ? ` at ${c.ref.checkedOutAt}` : ""}` : { branch: c.ref.short };
      if (c.commit && c.commit.hash !== WORKING) return { commitish: c.commit.hash };
      return {};
    },
    fields: (c, a) => {
      const base = app.repo.info?.worktreePath?.replace(/\/+$/, "") ?? "";
      const name = String(a.branch ?? "worktree").replace(/[^\w.-]+/g, "-");
      return [
        { name: "path", label: "Path", type: "text", required: true, value: base ? `${base}-${name}` : "" },
        ...(a.branch ? [] : [{ name: "newBranch", label: "New branch name (optional)", type: "text" as const }]),
      ];
    },
    finish: (a, v) => ({ ...a, path: String(v.path), newBranch: v.newBranch ? String(v.newBranch) : undefined }),
  },
  "git.worktree.remove": { contexts: ["worktree"], bind: (c) => (c.worktree && !c.worktree.isMain ? { path: c.worktree.path } : "Pick a linked worktree"), fields: () => [{ name: "force", label: "Force (discard its uncommitted changes)", type: "checkbox", value: false }] },
  "git.worktree.lock": { contexts: ["worktree"], bind: (c) => (c.worktree && !c.worktree.locked ? { path: c.worktree.path } : "Pick an unlocked worktree"), fields: () => [{ name: "reason", label: "Reason", type: "text" }] },
  "git.worktree.unlock": { contexts: ["worktree"], bind: (c) => (c.worktree?.locked ? { path: c.worktree.path } : "Pick a locked worktree") },
  "git.worktree.prune": { contexts: "global", bind: () => ({ dryRun: false }) },
  "git.clean": {
    label: () => "Clean untracked files…",
    contexts: ["uncommitted"],
    bind: () => (app.repo.status?.untracked.length ? { paths: app.repo.status.untracked, dryRun: false } : "There are no untracked files"),
  },
  "git.git.run": {
    label: () => "Run Git command…",
    contexts: "global",
    bind: () => ({}),
    fields: () => [{ name: "args", label: `git … (runs in ${app.repo.info?.worktreePath ?? "the selected worktree"})`, type: "text", required: true, placeholder: "log --oneline -5" }],
    finish: (a, v) => {
      const args = splitArgs(String(v.args ?? ""));
      if (!args.length) return "Enter git arguments";
      if (args[0] === "git") args.shift();
      return { ...a, args };
    },
  },
};

/** Split a command line into arguments, honouring single/double quotes and backslashes (no shell). */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === q) q = null;
      else if (ch === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

export function portCall<T>(name: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  return app.engine.call<T>({ method: "port", args: { session: app.sessionId(), name, params } }, signal);
}

/** Run a repository mutation on the owning host, with the confirmation round-trip. */
export async function executeRemote(command: string, args: Record<string, unknown>, title: string): Promise<MutationResult | null> {
  let confirm: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    app.setBusy(title);
    try {
      const result = await app.engine.call<MutationResult>({ method: "execute", args: { session: app.sessionId(), command, params: args, confirm } });
      return result;
    } catch (e) {
      const err = AppError.from(e);
      if (err.code === "CONFIRMATION_REQUIRED" && !confirm) {
        app.setBusy(null);
        const ok = await app.ask({ title, consequence: String(err.details?.consequence ?? err.message), confirmLabel: "Yes, continue", danger: true });
        if (!ok) return null;
        confirm = String(err.details?.confirmToken ?? "");
        continue;
      }
      throw err;
    } finally {
      app.setBusy(null);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// UI commands
// ---------------------------------------------------------------------------

function ui(def: Omit<UiCommand, "kind" | "args"> & { args?: z.ZodType; scope?: Scope }): UiCommand {
  const d = defineCommand({ kind: "ui", args: def.args ?? noArgs, ...def } as AnyCommand) as UiCommand;
  d.scope = def.scope ?? "graph";
  return d;
}

const hasRepo = () => (app.view().repo ? { enabled: true as const } : { enabled: false as const, reason: "Open a repository first" });
const hasRows = () => (app.rows.length ? { enabled: true as const } : { enabled: false as const, reason: "No commits are loaded" });

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    app.toast("success", `Copied ${what}`);
  } catch {
    await app.ask({ title: `Copy ${what}`, message: "Clipboard access was blocked. Select and copy:", fields: [{ name: "v", label: what, type: "readonly", value: text }], confirmLabel: "Done" });
  }
}

export function currentLink(state?: ViewState): string {
  return buildUrl(location.origin, { ...(state ?? app.view()), at: null });
}

async function openFolder() {
  if (!fsAccessSupported) {
    app.toast("error", "This browser cannot open local folders", "Use Chrome or Edge, or run `git-graph open .` to use the local companion.");
    return;
  }
  try {
    const handle = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: "read", id: "lanes-repo" });
    const id = newHandleId();
    await saveHandle(id, handle);
    app.rememberRecent({ key: `browser:${id}`, name: handle.name, at: Date.now() });
    app.navigate({ ...app.view(), repo: { provider: "browser", id }, branches: [], commit: null, compare: null, selected: [], view: "graph", file: null, at: null, worktree: null });
  } catch (e) {
    if ((e as DOMException).name !== "AbortError") app.toast("error", "Could not open folder", String(e));
  }
}

export async function openWorktreePath(path: string) {
  try {
    const info = await executeRemote("local.open", { path }, `Open ${path}`);
    const ri = info as unknown as RepoInfo | null;
    if (ri?.key) {
      const id = ri.key.split(":")[1]!;
      app.rememberRecent({ key: ri.key, name: ri.name, path: ri.worktreePath, at: Date.now() });
      app.navigate({ ...app.view(), repo: { provider: "local", id }, commit: null, compare: null, selected: [], view: "graph", file: null, at: null, worktree: null });
    }
  } catch (e) {
    app.toast("error", `Could not open worktree ${path}`, AppError.from(e).message);
  }
}

function uiCommands(): UiCommand[] {
  return [
    ui({ id: "palette.open", title: "Show All Commands", description: "Open the command palette.", category: "Help", shortcuts: ["Mod+Shift+P", "F1"], scope: "global", execute: () => app.setPaletteOpen({ mode: "commands" }) }),
    ui({ id: "help.shortcuts", title: "Keyboard Shortcuts", description: "Searchable list of every shortcut.", category: "Help", shortcuts: ["?"], execute: () => app.setHelpOpen(true) }),
    ui({ id: "find.open", title: "Find", description: "Find commits by message, author, hash or ref.", category: "Navigation", shortcuts: ["Mod+F", "/"], scope: "global", when: hasRepo, execute: () => app.setFind("open", true) }),
    ui({ id: "find.next", title: "Find Next", description: "Go to the next match.", category: "Navigation", shortcuts: ["F3", "Mod+G"], scope: "global", when: () => (app.find.matches.length ? { enabled: true } : { enabled: false, reason: "No find results" }), execute: () => app.findStep(1) }),
    ui({ id: "find.prev", title: "Find Previous", description: "Go to the previous match.", category: "Navigation", shortcuts: ["Shift+F3", "Mod+Shift+G"], scope: "global", when: () => (app.find.matches.length ? { enabled: true } : { enabled: false, reason: "No find results" }), execute: () => app.findStep(-1) }),
    ui({ id: "nav.down", title: "Next Commit", description: "Move to the commit below.", category: "Navigation", shortcuts: ["ArrowDown", "j"], when: hasRows, execute: () => app.moveKb(1) }),
    ui({ id: "nav.up", title: "Previous Commit", description: "Move to the commit above.", category: "Navigation", shortcuts: ["ArrowUp", "k"], when: hasRows, execute: () => app.moveKb(-1) }),
    ui({ id: "nav.pageDown", title: "Page Down", description: "Move one page down.", category: "Navigation", shortcuts: ["PageDown"], when: hasRows, execute: () => app.moveKb(Math.max(1, Math.floor((app.getScrollEl()?.clientHeight ?? 480) / 24) - 1)) }),
    ui({ id: "nav.pageUp", title: "Page Up", description: "Move one page up.", category: "Navigation", shortcuts: ["PageUp"], when: hasRows, execute: () => app.moveKb(-Math.max(1, Math.floor((app.getScrollEl()?.clientHeight ?? 480) / 24) - 1)) }),
    ui({ id: "nav.first", title: "First Commit", description: "Jump to the top of the graph.", category: "Navigation", shortcuts: ["Home"], when: hasRows, execute: () => app.jumpTo(0) }),
    ui({ id: "nav.last", title: "Last Loaded Commit", description: "Jump to the last loaded commit (loads more).", category: "Navigation", shortcuts: ["End"], when: hasRows, execute: () => app.jumpTo(app.rows.length - 1) }),
    ui({ id: "nav.parent", title: "Go to Parent", description: "Move to the first parent of the commit.", category: "Navigation", shortcuts: ["Mod+ArrowDown", "Alt+ArrowDown"], when: hasRows, execute: () => app.toParent(false) }),
    ui({ id: "nav.parentAlt", title: "Go to Other Parent", description: "Follow the merged-in (second) parent.", category: "Navigation", shortcuts: ["Mod+Shift+ArrowDown", "Alt+Shift+ArrowDown"], when: hasRows, execute: () => app.toParent(true) }),
    ui({ id: "nav.child", title: "Go to Child", description: "Move to the child commit on the same branch.", category: "Navigation", shortcuts: ["Mod+ArrowUp", "Alt+ArrowUp"], when: hasRows, execute: () => app.toChild(false) }),
    ui({ id: "nav.childAlt", title: "Go to Other Child", description: "Move to a child on another branch.", category: "Navigation", shortcuts: ["Mod+Shift+ArrowUp", "Alt+Shift+ArrowUp"], when: hasRows, execute: () => app.toChild(true) }),
    ui({ id: "nav.head", title: "Go to HEAD", description: "Center the checked-out commit (or Uncommitted Changes).", category: "Navigation", shortcuts: ["h"], when: hasRows, execute: () => app.goHead() }),
    ui({ id: "nav.nextStash", title: "Next Stash", description: "Go to the next stash.", category: "Navigation", shortcuts: ["s"], when: hasRows, execute: () => app.nextStash(1) }),
    ui({ id: "nav.prevStash", title: "Previous Stash", description: "Go to the previous stash.", category: "Navigation", shortcuts: ["Shift+S"], when: hasRows, execute: () => app.nextStash(-1) }),
    ui({ id: "refs.next", title: "Next Ref on Row", description: "Focus the next branch/tag label on the focused row.", category: "Navigation", shortcuts: ["ArrowRight"], when: hasRows, execute: () => cycleRef(1) }),
    ui({ id: "refs.prev", title: "Previous Ref on Row", description: "Focus the previous branch/tag label (or the commit itself).", category: "Navigation", shortcuts: ["ArrowLeft"], when: hasRows, execute: () => cycleRef(-1) }),
    ui({ id: "details.open", title: "Open Commit Details", description: "Expand the focused commit in place.", category: "View", shortcuts: ["Enter"], when: hasRows, execute: () => app.openDetails() }),
    ui({ id: "view.back", title: "Back", description: "Close the innermost view (diff → details → selection).", category: "View", shortcuts: ["Escape"], scope: "global", execute: () => goBack() }),
    ui({ id: "select.toggle", title: "Toggle Selection", description: "Add or remove the focused commit from the selection.", category: "View", shortcuts: ["Space"], when: hasRows, execute: () => app.toggleSelect() }),
    ui({
      id: "compare.withSelected",
      title: "Compare with Selected Commit",
      description: "Show the changes between the selected commit and the focused commit.",
      category: "View",
      shortcuts: ["c"],
      contexts: ["commit"],
      when: () => (app.view().commit || app.view().selected.length ? { enabled: true } : { enabled: false, reason: "Select a commit first (Space)" }),
      execute: () => app.compareWith(),
    }),
    ui({ id: "menu.context", title: "Show Context Menu", description: "Actions for the focused commit, ref, file or hunk.", category: "View", shortcuts: ["Shift+F10", "ContextMenu"], scope: "global", execute: () => openContextMenuForFocus() }),
    ui({ id: "tooltip.show", title: "Show Commit Info", description: "Show the tooltip for the focused commit.", category: "View", shortcuts: ["i"], when: hasRows, execute: () => toggleTooltip() }),
    ui({ id: "graph.refresh", title: "Refresh", description: "Reconcile with the repository now (normally automatic).", category: "Repository", shortcuts: ["r"], when: hasRepo, execute: () => app.engine.call({ method: "refresh", args: { session: app.sessionId(), reason: "manual", force: true } }) }),
    ui({ id: "repo.open", title: "Open Repository…", description: "Open a GitHub repository, a recent repository or a local folder.", category: "Repository", shortcuts: ["o"], scope: "graph", execute: () => app.setPaletteOpen({ mode: "repos" }) }),
    ui({ id: "repo.openFolder", title: "Open Folder in Browser (read-only)…", description: "Open a local repository through the browser's file access.", category: "Repository", execute: () => openFolder() }),
    ui({
      id: "repo.pasteGitHubUrl",
      title: "Open GitHub URL…",
      description: "Paste a github.com URL (repository, commit, branch or compare).",
      category: "Repository",
      execute: async () => {
        const v = await app.ask({ title: "Open GitHub URL", fields: [{ name: "url", label: "GitHub URL or owner/repo", type: "text", required: true }], confirmLabel: "Open" });
        if (v) openGitHubInput(String(v.url));
      },
    }),
    ui({ id: "branches.filter", title: "Filter Branches…", description: "Choose which branches are shown.", category: "View", shortcuts: ["b"], when: hasRepo, execute: () => app.setPaletteOpen({ mode: "branches" }) }),
    ui({ id: "branches.showAll", title: "Show All Branches", description: "Clear the branch filter.", category: "View", when: () => (app.view().branches.length ? { enabled: true } : { enabled: false, reason: "All branches are already shown" }), execute: () => app.navigate({ branches: [], focusBranch: null }) }),
    ui({ id: "branches.focus", title: "Focus Branch", description: "Show only the focused branch label's branch.", category: "View", contexts: ["ref"], when: () => (currentContext().ref ? { enabled: true } : { enabled: false, reason: "Focus a branch label (←/→)" }), execute: () => {
      const r = currentContext().ref!;
      app.navigate({ branches: [r.short], focusBranch: r.short });
    } }),
    ui({ id: "view.toggleRemotes", title: "Toggle Remote Branches", description: "Show or hide remote-tracking branches.", category: "View", when: hasRepo, execute: () => app.navigate({ display: { ...app.view().display, remotes: !app.view().display.remotes } }) }),
    ui({ id: "view.toggleTags", title: "Toggle Tags", description: "Show or hide tags.", category: "View", when: hasRepo, execute: () => app.navigate({ display: { ...app.view().display, tags: !app.view().display.tags } }) }),
    ui({ id: "view.toggleStashes", title: "Toggle Stashes", description: "Show or hide stashes.", category: "View", when: hasRepo, execute: () => app.navigate({ display: { ...app.view().display, stashes: !app.view().display.stashes } }) }),
    ui({ id: "view.firstParent", title: "Toggle First-Parent History", description: "Only follow first parents.", category: "View", when: hasRepo, execute: () => app.navigate({ display: { ...app.view().display, firstParent: !app.view().display.firstParent } }) }),
    ui({ id: "view.orderTopo", title: "Order Commits Topologically", description: "Switch between date and topological order.", category: "View", when: hasRepo, execute: () => app.navigate({ display: { ...app.view().display, order: app.view().display.order === "topo" ? "date" : "topo" } }) }),
    ui({ id: "view.toggleDate", title: "Toggle Date Column", description: "Show or hide the Date column.", category: "View", execute: () => app.setColumns({ ...app.columns(), showDate: !app.columns().showDate }) }),
    ui({ id: "view.toggleAuthor", title: "Toggle Author Column", description: "Show or hide the Author column.", category: "View", execute: () => app.setColumns({ ...app.columns(), showAuthor: !app.columns().showAuthor }) }),
    ui({ id: "view.toggleHash", title: "Toggle Commit Column", description: "Show or hide the Commit column.", category: "View", execute: () => app.setColumns({ ...app.columns(), showHash: !app.columns().showHash }) }),
    ui({ id: "columns.resize", title: "Resize Columns…", description: "Focus the first column divider; use ←/→ to resize and Tab to move between dividers.", category: "View", execute: () => document.querySelector<HTMLElement>(".col-resizer")?.focus() }),
    ui({ id: "columns.reset", title: "Reset Column Widths", description: "Restore default column widths.", category: "View", execute: () => app.setColumns({ graph: null, date: 124, author: 110, hash: 76, showDate: true, showAuthor: true, showHash: true }) }),
    ui({ id: "theme.toggle", title: "Toggle Theme (System / Light / Dark)", description: "Cycle the color theme.", category: "View", execute: () => app.setTheme(app.theme() === "system" ? "light" : app.theme() === "light" ? "dark" : "system") }),
    ui({ id: "link.copy", title: "Copy Link to This View", description: "Copy a deep link that reproduces the current view.", category: "Links", shortcuts: ["y"], when: hasRepo, execute: () => copy(currentLink(), "link") }),
    ui({ id: "link.copyCommit", title: "Copy Link to Commit", description: "Copy a deep link to the focused commit.", category: "Links", contexts: ["commit"], when: hasRows, execute: () => {
      const c = currentContext().commit;
      if (c && c.hash !== WORKING) void copy(currentLink({ ...app.view(), commit: c.hash, compare: null, view: "details", file: null, selected: [] }), "commit link");
    } }),
    ui({ id: "hash.copy", title: "Copy Commit Hash", description: "Copy the full hash of the focused commit.", category: "Commit", shortcuts: ["Shift+Y"], contexts: ["commit"], when: hasRows, execute: () => {
      const c = currentContext().commit;
      if (c && c.hash !== WORKING) void copy(c.hash, "hash");
    } }),
    ui({ id: "subject.copy", title: "Copy Commit Subject", description: "Copy the subject line of the focused commit.", category: "Commit", contexts: ["commit"], when: hasRows, execute: () => {
      const c = currentContext().commit;
      if (c) void copy(c.subject, "subject");
    } }),
    ui({ id: "ref.copy", title: "Copy Ref Name", description: "Copy the focused branch, tag or stash name.", category: "Branch", contexts: ["ref", "stash"], when: () => (currentContext().ref ? { enabled: true } : { enabled: false, reason: "Focus a ref label (←/→)" }), execute: () => void copy(currentContext().ref!.short, "name") }),
    ui({
      id: "worktree.open",
      title: "Open Worktree of Branch",
      description: "Open the worktree where the focused branch is checked out.",
      category: "Worktree",
      contexts: ["ref"],
      when: () => {
        const r = currentContext().ref;
        return r?.checkedOutAt && r.checkedOutAt !== app.repo.info?.worktreePath ? { enabled: true } : { enabled: false, reason: "The focused branch is not checked out in another worktree" };
      },
      execute: () => void openWorktreePath(currentContext().ref!.checkedOutAt!),
    }),
    ui({ id: "worktree.switch", title: "Switch Worktree…", description: "Pick a linked worktree to open.", category: "Worktree", shortcuts: ["w"], capability: "worktrees", execute: () => app.setPaletteOpen({ mode: "worktrees" }) }),
    ui({ id: "rebase.interactive", title: "Interactive Rebase from Here…", description: "Edit the commits after the focused commit (pick, reword, squash, fixup, drop).", category: "Branch", contexts: ["commit"], capability: "interactiveRebase", execute: () => void interactiveRebase() }),
    ui({ id: "companion.connect", title: "Connect Local Companion…", description: "Pair with `git-graph serve` running on this computer.", category: "Account", execute: () => void connectCompanion() }),
    ui({ id: "companion.disconnect", title: "Disconnect Local Companion", description: "Forget the companion token in this browser.", category: "Account", when: () => (app.companion().token ? { enabled: true } : { enabled: false, reason: "Not connected" }), execute: () => app.setCompanion({ ...app.companion(), token: null }) }),
    ui({
      id: "account.signIn",
      title: "Sign in with GitHub",
      description: "Authorize access to your private repositories.",
      category: "Account",
      scope: "global",
      when: () => (!app.auth.serverAvailable ? { enabled: false, reason: "No Lanes server is reachable (static hosting): GitHub sign-in needs the backend" } : app.auth.authenticated ? { enabled: false, reason: `Already signed in as ${app.auth.user?.login}` } : { enabled: true }),
      execute: () => {
        location.href = app.loginUrl();
      },
    }),
    ui({
      id: "account.signOut",
      title: "Sign Out",
      description: "End the GitHub session.",
      category: "Account",
      scope: "global",
      when: () => (app.auth.authenticated ? { enabled: true } : { enabled: false, reason: "Not signed in" }),
      execute: async () => {
        await fetch("/auth/logout", { method: "POST", credentials: "include", headers: { "content-type": "application/json" } }).catch(() => {});
        await app.checkSession();
        void app.openRepo(app.view());
      },
    }),
    ui({ id: "metrics.show", title: "Show Performance Metrics", description: "Measured timings for this session.", category: "Help", execute: () => void app.ask({ title: "Performance metrics", output: { text: JSON.stringify(app.metrics, null, 2) }, confirmLabel: "Close" }) }),
  ];
}

// ---------------------------------------------------------------------------

function cycleRef(dir: 1 | -1) {
  const c = app.rows.commits[app.kbRow()];
  if (!c) return;
  const refs = app.refsByCommit().get(c.hash) ?? [];
  if (!refs.length) {
    app.setRefCursor(-1);
    return;
  }
  let i = app.refCursor() + dir;
  if (i < -1) i = refs.length - 1;
  if (i >= refs.length) i = -1;
  app.setRefCursor(i);
}

function toggleTooltip() {
  if (app.tooltip()) return app.setTooltip(null);
  const el = document.querySelector<HTMLElement>(`[data-row="${app.kbRow()}"]`);
  const rect = el?.getBoundingClientRect();
  app.setTooltip({ x: (rect?.left ?? 40) + 40, y: (rect?.bottom ?? 80) + 4, row: app.kbRow() });
}

export function goBack() {
  if (app.tooltip()) return app.setTooltip(null);
  if (app.find.open) {
    app.setFind("open", false);
    return app.focusGraph();
  }
  const v = app.view();
  if (app.refCursor() >= 0) return app.setRefCursor(-1);
  if (v.view === "diff") return app.closeDiff();
  if (v.view === "details") return app.closeDetails();
  if (v.selected.length || v.commit) return app.navigate({ commit: null, selected: [], compare: null }, { replace: true });
  if (app.toasts.length) return app.dismissToast();
}

export function openGitHubInput(input: string) {
  {
    const gh = parseGitHubInput(input);
    if (!gh) return app.toast("error", `Not a GitHub repository: ${input}`);
    app.navigate({
      ...app.view(),
      repo: gh.repo,
      branches: gh.branch ? [gh.branch] : [],
      focusBranch: null,
      commit: gh.commit ?? null,
      compare: null,
      selected: [],
      view: gh.commit ? "details" : "graph",
      file: null,
      at: null,
      worktree: null,
    });
    if (gh.compare) app.toast("info", `Comparing ${gh.compare[0]}...${gh.compare[1]}: select both commits with Space and press C`);
  }
}

async function connectCompanion() {
  const v = await app.ask({
    title: "Connect local companion",
    message: "Run `git-graph pair` (or `git-graph open .`) in a terminal, then paste the one-time code.",
    fields: [
      { name: "url", label: "Companion address", type: "text", value: app.companion().baseUrl },
      { name: "code", label: "Pairing code", type: "text", required: true },
    ],
    confirmLabel: "Connect",
  });
  if (v && (await app.pairCompanion(String(v.code).trim(), String(v.url).replace(/\/+$/, "")))) void app.openRepo(app.view());
}

async function interactiveRebase() {
  const c = currentContext().commit;
  if (!c || c.hash === WORKING) return app.toast("info", "Focus the base commit first");
  const head = app.headCommit();
  const headRow = head ? app.rows.index.get(head) : undefined;
  const baseRow = app.rows.index.get(c.hash);
  if (headRow === undefined || baseRow === undefined || baseRow <= headRow) return app.toast("error", "The focused commit must be an ancestor of HEAD");
  // Commits between base (exclusive) and HEAD (inclusive), oldest first, following first parents.
  const chain: RowCommit[] = [];
  let cur: string | undefined = head!;
  while (cur && cur !== c.hash && chain.length < 500) {
    const r = app.rows.index.get(cur);
    if (r === undefined) break;
    const commit: RowCommit = app.rows.commits[r]!;
    chain.push(commit);
    cur = commit.parents[0];
  }
  if (cur !== c.hash) return app.toast("error", "The focused commit is not on the first-parent history of HEAD");
  chain.reverse();
  const v = await app.ask({
    title: `Interactive rebase onto ${short(c.hash)}`,
    message: "One line per commit, oldest first: <action> <hash> [new message for reword]. Actions: pick, reword, edit, squash, fixup, drop. Reorder lines to reorder commits.",
    fields: [{ name: "todo", label: "Plan", type: "textarea", value: chain.map((x) => `pick ${short(x.hash)} ${x.subject}`).join("\n") }],
    confirmLabel: "Start rebase",
  });
  if (!v) return;
  const byShort = new Map(chain.map((x) => [short(x.hash), x.hash]));
  const todo: { action: "pick" | "reword" | "edit" | "squash" | "fixup" | "drop"; hash: string; message?: string }[] = [];
  for (const line of String(v.todo).split("\n")) {
    const m = /^\s*(pick|reword|edit|squash|fixup|drop|p|r|e|s|f|d)\s+([0-9a-f]{4,40})\s*(.*)$/.exec(line);
    if (!m) continue;
    const full = byShort.get(m[2]!.slice(0, 8)) ?? [...byShort.values()].find((h) => h.startsWith(m[2]!));
    if (!full) return app.toast("error", `Unknown commit ${m[2]}`);
    const ABBR: Record<string, "pick" | "reword" | "edit" | "squash" | "fixup" | "drop"> = { p: "pick", r: "reword", e: "edit", s: "squash", f: "fixup", d: "drop" };
    const action = ABBR[m[1]!] ?? (m[1] as "pick" | "reword" | "edit" | "squash" | "fixup" | "drop");
    const orig = chain.find((x) => x.hash === full)!;
    todo.push({ action, hash: full, message: action === "reword" && m[3] && m[3] !== orig.subject ? m[3] : undefined });
  }
  await invokeMutation("git.rebase", { commit: c, ref: null, file: null, hunk: null, worktree: null }, { onto: c.hash, todo });
}

// ---------------------------------------------------------------------------
// Registry + invocation
// ---------------------------------------------------------------------------

export const registry = new CommandRegistry();
registry.register(...repoCommands(), ...uiCommands());

/** Commands added by the local companion (clone, init, open…) are server-side only; describe the ones the UI uses. */
const COMPANION_ONLY = new Set(["local.open", "local.clone", "local.init"]);
void COMPANION_ONLY;

export function commandAvailability(cmd: AnyCommand, ctx: UiContext): { enabled: boolean; reason?: string; args?: Record<string, unknown> } {
  if (cmd.kind === "ui") {
    if (cmd.capability) {
      const c = app.repo.caps?.[cmd.capability];
      if (!c) return { enabled: false, reason: "Open a repository first" };
      if (!c.available) return { enabled: false, reason: c.reason };
    }
    const w = cmd.when?.({ appOrigin: location.origin }, {});
    if (w && !(w instanceof Promise) && !w.enabled) return w;
    return { enabled: true };
  }
  if (cmd.kind === "mutation") {
    const b = BINDERS[cmd.id];
    if (!b) return { enabled: false, reason: "Not available from the UI" };
    if (!app.view().repo) return { enabled: false, reason: "Open a repository first" };
    const caps = app.repo.caps;
    if (!caps) return { enabled: false, reason: "Repository is still loading" };
    if (cmd.capability && !caps[cmd.capability].available) return { enabled: false, reason: (caps[cmd.capability] as { reason: string }).reason };
    const args = b.bind(ctx);
    if (typeof args === "string") return { enabled: false, reason: args };
    return { enabled: true, args };
  }
  return { enabled: false, reason: "Query command" };
}

export function commandTitle(cmd: AnyCommand, ctx: UiContext): string {
  const b = BINDERS[cmd.id];
  return b?.label ? b.label(ctx) : cmd.title;
}

export function commandTarget(cmd: AnyCommand, ctx: UiContext): string {
  if (cmd.kind === "mutation") {
    const b = BINDERS[cmd.id];
    if (b && b.contexts !== "global") return describeTarget(ctx);
    if (cmd.category === "Remote" || cmd.id.startsWith("git.operation") || cmd.id === "git.commit" || cmd.id === "git.git.run")
      return app.repo.info?.worktreePath ?? app.repo.info?.name ?? "";
    return "";
  }
  if (cmd.contexts?.length) return describeTarget(ctx);
  return "";
}

export async function invokeMutation(id: string, ctx: UiContext, override?: Record<string, unknown>) {
  const cmd = registry.get(id)!;
  const a = commandAvailability(cmd, ctx);
  if (!a.enabled && !override) {
    app.toast("error", `${cmd.title}: unavailable`, a.reason);
    return;
  }
  const b = BINDERS[id]!;
  let args: Record<string, unknown> = { ...(a.args ?? {}), ...(override ?? {}) };
  const title = commandTitle(cmd, ctx);
  if (!override) {
    const fields = b.fields ? await b.fields(ctx, args) : [];
    if (fields.length) {
      const target = commandTarget(cmd, ctx);
      const v = await app.ask({ title, message: target ? `Target: ${target}` : undefined, fields, confirmLabel: cmd.title.replace(/…$/, "") });
      if (!v) return;
      const fin = b.finish ? b.finish(args, v) : { ...args, ...v };
      if (typeof fin === "string") {
        app.toast("error", fin);
        return;
      }
      args = fin;
    }
  }
  // Clean: preview the exact list first (dry run), then confirm the real deletion.
  if (id === "git.clean") {
    const preview = await executeRemote(id, { ...args, dryRun: true }, title).catch((e) => {
      app.toast("error", "Clean preview failed", AppError.from(e).message);
      return null;
    });
    if (!preview) return;
    const affected = preview.affected ?? [];
    if (!affected.length) return app.toast("info", "Nothing to clean");
    args = { ...args, paths: affected, dryRun: false };
  }
  try {
    const res = await executeRemote(id, args, title);
    if (!res) return;
    if (id === "git.git.run") {
      await app.ask({
        title: "Run Git command",
        output: { cwd: app.repo.info?.worktreePath, args: `git ${(args.args as string[]).join(" ")}`, exitCode: res.exitCode, text: res.output || "(no output)" },
        confirmLabel: "Close",
      });
      return;
    }
    app.toast("success", `${title} — done`, res.output ? res.output.slice(0, 400) : undefined);
  } catch (e) {
    const err = AppError.from(e);
    const hint =
      err.code === "STALE_STATE"
        ? "The repository changed since you started this action. The graph has been refreshed; review it and try again."
        : err.code === "UNSUPPORTED"
          ? err.message
          : undefined;
    app.toast("error", `${title} failed`, hint ?? err.message);
  }
}

/** Run any command by id from the palette, a shortcut or a menu. */
export async function invoke(id: string, ctx: UiContext = currentContext()) {
  const cmd = registry.get(id);
  if (!cmd) return;
  if (cmd.kind === "mutation") return invokeMutation(id, ctx);
  const a = commandAvailability(cmd, ctx);
  if (!a.enabled) {
    app.toast("info", `${cmd.title} is unavailable`, a.reason);
    return;
  }
  try {
    await cmd.execute({}, { appOrigin: location.origin, host: ctx });
  } catch (e) {
    app.toast("error", `${cmd.title} failed`, AppError.from(e).message);
  }
}

export function paletteCommands(): AnyCommand[] {
  return registry.list((c) => (c.kind === "ui" || (c.kind === "mutation" && !!BINDERS[c.id])) && !c.hidden);
}

export function shortcutCommands(): UiCommand[] {
  return registry.list((c) => c.kind === "ui" && !!c.shortcuts?.length).map((c) => c as UiCommand).filter((c) => c.shortcuts!.every((s) => !isReserved(s)));
}

/** Menu entries for a context, in a stable order: UI commands then mutations by category. */
export function menuCommands(kind: MenuContext): AnyCommand[] {
  return registry.list((c) => {
    if (c.kind === "query") return false;
    if (c.kind === "mutation") {
      const b = BINDERS[c.id];
      return !!b && b.contexts !== "global" && b.contexts.includes(kind);
    }
    return !!c.contexts?.includes(kind);
  });
}

export function openContextMenuForFocus(anchor?: { x: number; y: number }) {
  const ctx = currentContext();
  const c = ctx.commit;
  if (!c) return;
  const kind: MenuContext = ctx.ref ? (ctx.ref.kind === "stash" ? "stash" : "ref") : c.hash === WORKING ? "uncommitted" : "commit";
  openMenu(kind, ctx, anchor);
}

const MENU_ORDER: Partial<Record<MenuContext, string[]>> = {
  commit: ["git.tag.create", "git.branch.create", "|", "git.checkout", "|", "git.cherry-pick", "git.revert", "|", "git.merge", "git.rebase", "git.reset", "|", "hash.copy", "subject.copy", "|"],
  ref: ["git.checkout", "worktree.open", "git.branch.rename", "git.branch.delete", "|", "git.merge", "git.rebase", "git.push", "git.upstream.set", "|", "git.tag.push", "git.tag.delete", "|", "branches.focus", "ref.copy", "|"],
  stash: ["git.stash.apply", "git.stash.branch", "git.stash.pop", "git.stash.drop", "|", "ref.copy", "hash.copy", "|"],
  uncommitted: ["git.commit", "git.stash.push", "|", "git.clean", "|"],
};

export function openMenu(kind: MenuContext, ctx: UiContext, anchor?: { x: number; y: number }) {
  const restore = document.activeElement as HTMLElement | null;
  let pos = anchor;
  if (!pos) {
    const el = document.querySelector<HTMLElement>(ctx.ref ? ".ref.focused" : `[data-row="${app.kbRow()}"] .subject`) ?? document.querySelector<HTMLElement>(`[data-row="${app.kbRow()}"]`);
    const r = el?.getBoundingClientRect();
    pos = { x: (r?.left ?? 100) + 8, y: (r?.bottom ?? 100) + 2 };
  }
  const cmds = menuCommands(kind);
  // Git Graph's grouping and order first, then additional actions.
  const order = MENU_ORDER[kind] ?? [];
  const ordered: (AnyCommand | null)[] = [];
  for (const id of order) {
    if (id === "|") ordered.push(null);
    else {
      const c = cmds.find((x) => x.id === id);
      if (c) ordered.push(c);
    }
  }
  const rest = cmds.filter((c) => !order.includes(c.id));
  if (rest.length) ordered.push(null, ...rest);
  const items: MenuItem[] = [];
  for (const cmd of ordered) {
    if (!cmd) {
      if (items.length && !items[items.length - 1]!.separator) items.push({ id: `sep${items.length}`, label: "", separator: true });
      continue;
    }
    const av = commandAvailability(cmd, ctx);
    if (!av.enabled && /^Focus a|^Pick a/.test(av.reason ?? "")) continue; // never applies to this target type
    const title = commandTitle(cmd, ctx);
    items.push({
      id: cmd.id,
      label: title + (cmd.kind === "mutation" && BINDERS[cmd.id]?.fields && !title.endsWith("…") ? "…" : ""),
      shortcut: cmd.shortcuts?.[0],
      disabled: av.enabled ? null : (av.reason ?? "Unavailable"),
      run: () => void (cmd.kind === "mutation" ? invokeMutation(cmd.id, ctx) : invoke(cmd.id, ctx)),
    });
  }
  while (items.length && items[items.length - 1]!.separator) items.pop();
  app.setMenu({ x: pos.x, y: pos.y, title: describeTarget(ctx), items, restore });
}
