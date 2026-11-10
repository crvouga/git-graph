// Repository commands: structured queries, mutations and deep links.
// These are host-agnostic: the server, the local companion, the browser UI and MCP all register them.

import { z } from "zod";
import { AppError, DEFAULT_HISTORY_QUERY, type Capability, type GitMutation, type MutationPrecondition } from "../types.ts";
import { buildUrl, EMPTY_VIEW, DEFAULT_DISPLAY, normalizeHash, type ViewState } from "../url/state.ts";
import { parseRepoKey } from "../types.ts";
import { CommandRegistry, defineCommand, resolveRepo, type AnyCommand, type CommandContext } from "./registry.ts";

const repoArg = z.string().min(1).describe('Repository key, e.g. "github:owner:repo" or "local:<id>". Defaults to the focused repository in the UI.');
const hashArg = z.string().regex(/^[0-9a-fA-F]{4,64}$/, "must be a hex object id");
const refish = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => !s.startsWith("-"), "must not start with '-'")
  .describe("A ref name or commit hash");
const pathArg = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !s.includes("\0"), "must not contain NUL");
const precondition = z
  .object({
    refsVersion: z.string().optional(),
    ref: z.object({ name: z.string(), commit: hashArg }).optional(),
  })
  .optional()
  .describe("Optimistic-concurrency precondition; the mutation fails with STALE_STATE if the repository changed.");

const short = (h: string) => h.slice(0, 8);

async function refCommit(ctx: CommandContext, repoKey: string | undefined, name: string): Promise<string | null> {
  try {
    const repo = await resolveRepo(ctx, repoKey);
    const snap = await repo.refs({ signal: ctx.signal });
    const r = snap.refs.find((x) => x.short === name || x.name === name || x.name === `refs/heads/${name}` || x.name === `refs/tags/${name}`);
    return r ? r.commit : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const queries: AnyCommand[] = [
  defineCommand({
    id: "repo.list",
    title: "List repositories",
    description: "List repositories available to the caller (recent local repositories or GitHub repositories you can access).",
    category: "Repository",
    kind: "query",
    args: z.object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() }),
    execute: async (a, ctx) => {
      if (!ctx.resolver) throw new AppError("UNSUPPORTED", "No repository resolver on this host");
      return ctx.resolver.list({ query: a.query, limit: a.limit });
    },
  }),
  defineCommand({
    id: "repo.info",
    title: "Repository info",
    description: "Name, default branch, visibility, viewer permission and paths of a repository.",
    category: "Repository",
    kind: "query",
    args: z.object({ repo: repoArg.optional() }),
    execute: async (a, ctx) => (await resolveRepo(ctx, a.repo)).info({ signal: ctx.signal }),
  }),
  defineCommand({
    id: "repo.capabilities",
    title: "Repository capabilities",
    description: "Which operations the repository's adapter supports, with a reason for each unavailable one.",
    category: "Repository",
    kind: "query",
    args: z.object({ repo: repoArg.optional() }),
    execute: async (a, ctx) => (await resolveRepo(ctx, a.repo)).capabilities({ signal: ctx.signal }),
  }),
  defineCommand({
    id: "repo.refs",
    title: "List refs",
    description: "HEAD state, branches, remote branches, tags and stashes, with a version digest for change detection.",
    category: "Repository",
    kind: "query",
    capability: "refs",
    args: z.object({ repo: repoArg.optional() }),
    execute: async (a, ctx) => (await resolveRepo(ctx, a.repo)).refs({ signal: ctx.signal }),
  }),
  defineCommand({
    id: "repo.history",
    title: "Commit history",
    description: "A page of commits in graph order. Pass the returned cursor to continue.",
    category: "History",
    kind: "query",
    capability: "history",
    args: z.object({
      repo: repoArg.optional(),
      refs: z.array(refish).max(100).optional(),
      includeRemotes: z.boolean().optional(),
      includeTags: z.boolean().optional(),
      includeStashes: z.boolean().optional(),
      firstParent: z.boolean().optional(),
      order: z.enum(["date", "topo", "author-date"]).optional(),
      cursor: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    }),
    execute: async (a, ctx) => {
      const repo = await resolveRepo(ctx, a.repo);
      return repo.history(
        {
          refs: a.refs ?? [],
          includeRemotes: a.includeRemotes ?? DEFAULT_HISTORY_QUERY.includeRemotes,
          includeTags: a.includeTags ?? DEFAULT_HISTORY_QUERY.includeTags,
          includeStashes: a.includeStashes ?? DEFAULT_HISTORY_QUERY.includeStashes,
          firstParent: a.firstParent ?? false,
          order: a.order ?? "date",
        },
        a.cursor ?? null,
        a.limit ?? 300,
        { signal: ctx.signal },
      );
    },
  }),
  defineCommand({
    id: "repo.commit",
    title: "Commit details",
    description: "Full message, author, committer, parents and changed files of one commit.",
    category: "Commit",
    kind: "query",
    capability: "commit",
    args: z.object({ repo: repoArg.optional(), hash: hashArg }),
    execute: async (a, ctx) => (await resolveRepo(ctx, a.repo)).commit(a.hash.toLowerCase(), { signal: ctx.signal }),
  }),
  defineCommand({
    id: "repo.diff",
    title: "Diff",
    description: "Structured diff of a commit (against its first parent), a comparison of two commits, or uncommitted changes.",
    category: "Commit",
    kind: "query",
    capability: "diff",
    args: z.object({
      repo: repoArg.optional(),
      hash: hashArg.optional().describe("Commit to diff against its first parent"),
      base: hashArg.optional(),
      head: hashArg.optional(),
      working: z.enum(["staged", "unstaged"]).optional(),
      path: pathArg.optional(),
      context: z.number().int().min(0).max(1000).optional(),
    }),
    execute: async (a, ctx) => {
      const repo = await resolveRepo(ctx, a.repo);
      const spec = a.working
        ? ({ kind: "working", staged: a.working === "staged" } as const)
        : a.base && a.head
          ? ({ kind: "compare", base: a.base.toLowerCase(), head: a.head.toLowerCase() } as const)
          : a.hash
            ? ({ kind: "commit", hash: a.hash.toLowerCase() } as const)
            : null;
      if (!spec) throw new AppError("BAD_REQUEST", "Provide hash, base+head, or working");
      return repo.diff(spec, { path: a.path, context: a.context, signal: ctx.signal });
    },
  }),
  defineCommand({
    id: "repo.compare",
    title: "Compare commits",
    description: "Files changed between two commits (base..head).",
    category: "Commit",
    kind: "query",
    capability: "compare",
    args: z.object({ repo: repoArg.optional(), base: hashArg, head: hashArg, path: pathArg.optional() }),
    execute: async (a, ctx) =>
      (await resolveRepo(ctx, a.repo)).diff({ kind: "compare", base: a.base.toLowerCase(), head: a.head.toLowerCase() }, { path: a.path, signal: ctx.signal }),
  }),
  defineCommand({
    id: "repo.fileHistory",
    title: "File history",
    description: "Commits that changed a file, following renames.",
    category: "History",
    kind: "query",
    capability: "fileHistory",
    args: z.object({ repo: repoArg.optional(), path: pathArg, cursor: z.string().nullable().optional(), limit: z.number().int().min(1).max(1000).optional() }),
    execute: async (a, ctx) => (await resolveRepo(ctx, a.repo)).fileHistory(a.path, a.cursor ?? null, a.limit ?? 100, { signal: ctx.signal }),
  }),
  defineCommand({
    id: "repo.blame",
    title: "Blame",
    description: "Per-line last-change information for a file at a revision.",
    category: "History",
    kind: "query",
    capability: "blame",
    args: z.object({ repo: repoArg.optional(), path: pathArg, rev: refish.optional() }),
    execute: async (a, ctx) => (await resolveRepo(ctx, a.repo)).blame(a.path, a.rev ?? "HEAD", { signal: ctx.signal }),
  }),
  defineCommand({
    id: "repo.search",
    title: "Search commits",
    description: "Search the full history by hash prefix, subject, author or ref.",
    category: "History",
    kind: "query",
    capability: "search",
    args: z.object({
      repo: repoArg.optional(),
      text: z.string().min(1).max(200),
      fields: z.array(z.enum(["hash", "subject", "body", "author", "ref"])).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    execute: async (a, ctx) => (await resolveRepo(ctx, a.repo)).search({ text: a.text, fields: a.fields, limit: a.limit ?? 50 }, { signal: ctx.signal }),
  }),
  defineCommand({
    id: "repo.file",
    title: "File contents",
    description: "Contents of a file at a revision.",
    category: "History",
    kind: "query",
    capability: "commit",
    args: z.object({ repo: repoArg.optional(), path: pathArg, rev: refish }),
    execute: async (a, ctx) => (await resolveRepo(ctx, a.repo)).file(a.path, a.rev, { signal: ctx.signal }),
  }),
  defineCommand({
    id: "repo.status",
    title: "Working tree status",
    description: "Staged, unstaged, untracked and conflicted files plus any in-progress operation.",
    category: "Working Tree",
    kind: "query",
    capability: "workingTree",
    args: z.object({ repo: repoArg.optional() }),
    execute: async (a, ctx) => (await resolveRepo(ctx, a.repo)).status({ signal: ctx.signal }),
  }),
  defineCommand({
    id: "repo.worktrees",
    title: "List worktrees",
    description: "Linked worktrees with their branch, lock and prunable state.",
    category: "Worktree",
    kind: "query",
    capability: "worktrees",
    args: z.object({ repo: repoArg.optional() }),
    execute: async (a, ctx) => (await resolveRepo(ctx, a.repo)).worktrees({ signal: ctx.signal }),
  }),
  defineCommand({
    id: "repo.remotes",
    title: "List remotes",
    description: "Configured remotes with fetch and push URLs (credentials removed).",
    category: "Remote",
    kind: "query",
    capability: "remotes",
    args: z.object({ repo: repoArg.optional() }),
    execute: async (a, ctx) => (await resolveRepo(ctx, a.repo)).remotes({ signal: ctx.signal }),
  }),
  defineCommand({
    id: "repo.conflict",
    title: "Inspect conflict",
    description: "Base, ours, theirs and working contents of a conflicted file.",
    category: "Working Tree",
    kind: "query",
    capability: "conflicts",
    args: z.object({ repo: repoArg.optional(), path: pathArg }),
    execute: async (a, ctx) => (await resolveRepo(ctx, a.repo)).conflict(a.path, { signal: ctx.signal }),
  }),
];

// ---------------------------------------------------------------------------
// Mutations. Each maps 1:1 to a GitMutation op.
// ---------------------------------------------------------------------------

type MutationSpec = {
  op: GitMutation["op"];
  title: string;
  description: string;
  category: AnyCommand["category"];
  capability: Capability;
  shape: z.ZodRawShape;
  contexts?: AnyCommand["contexts"];
  consequence?: (a: Record<string, any>, ctx: CommandContext) => Promise<string | null> | string | null;
};

const mutationSpecs: MutationSpec[] = [
  {
    op: "checkout",
    title: "Check out",
    description: "Switch the worktree to a branch, tag or commit. Git refuses if local changes would be overwritten.",
    category: "Branch",
    capability: "branchWrite",
    shape: { target: refish, track: z.boolean().optional() },
    contexts: ["ref", "commit"],
  },
  {
    op: "branch.create",
    title: "Create branch",
    description: "Create a branch at a commit, optionally checking it out.",
    category: "Branch",
    capability: "branchWrite",
    shape: { name: refish, target: refish, checkout: z.boolean().optional() },
    contexts: ["commit", "ref"],
  },
  {
    op: "branch.delete",
    title: "Delete branch",
    description: "Delete a local branch (or a remote branch when remote=true).",
    category: "Branch",
    capability: "branchWrite",
    shape: { name: refish, force: z.boolean().optional(), remote: z.boolean().optional() },
    contexts: ["ref"],
    consequence: async (a, ctx) => {
      const at = await refCommit(ctx, a.repo, a.name);
      return `${a.remote ? "Delete remote branch" : "Delete branch"} "${a.name}"${at ? ` (currently at ${short(at)})` : ""}.${
        a.force ? " Force: commits only reachable from this branch become unreachable." : " Git refuses if it is not fully merged."
      }`;
    },
  },
  {
    op: "branch.rename",
    title: "Rename branch",
    description: "Rename a branch.",
    category: "Branch",
    capability: "branchWrite",
    shape: { from: refish, to: refish },
    contexts: ["ref"],
  },
  {
    op: "tag.create",
    title: "Create tag",
    description: "Create a lightweight tag, or an annotated tag when a message is given.",
    category: "Tag",
    capability: "tagWrite",
    shape: { name: refish, target: refish, message: z.string().max(10000).optional(), sign: z.boolean().optional() },
    contexts: ["commit"],
  },
  {
    op: "tag.delete",
    title: "Delete tag",
    description: "Delete a tag.",
    category: "Tag",
    capability: "tagWrite",
    shape: { name: refish },
    contexts: ["ref"],
    consequence: async (a, ctx) => {
      const at = await refCommit(ctx, a.repo, a.name);
      return `Delete tag "${a.name}"${at ? ` (on ${short(at)})` : ""}. Remote copies are not affected.`;
    },
  },
  {
    op: "tag.push",
    title: "Push tag",
    description: "Push a tag to a remote.",
    category: "Tag",
    capability: "push",
    shape: { name: refish, remote: refish },
    contexts: ["ref"],
  },
  {
    op: "merge",
    title: "Merge into current branch",
    description: "Merge a branch or commit into the checked-out branch.",
    category: "Branch",
    capability: "merge",
    shape: { ref: refish, noFastForward: z.boolean().optional(), squash: z.boolean().optional(), noCommit: z.boolean().optional() },
    contexts: ["ref", "commit"],
  },
  {
    op: "rebase",
    title: "Rebase current branch",
    description: "Rebase the checked-out branch onto a ref. Supply `todo` for an interactive rebase plan.",
    category: "Branch",
    capability: "rebase",
    shape: {
      onto: refish,
      todo: z
        .array(z.object({ action: z.enum(["pick", "reword", "edit", "squash", "fixup", "drop"]), hash: hashArg, message: z.string().optional() }))
        .optional(),
    },
    contexts: ["ref", "commit"],
    consequence: (a) =>
      `Rebase the current branch onto "${a.onto}"${a.todo ? ` with an interactive plan of ${a.todo.length} steps` : ""}. Rebased commits get new hashes; the old ones stay reachable through the reflog.`,
  },
  {
    op: "cherry-pick",
    title: "Cherry-pick",
    description: "Apply the changes of one or more commits onto the current branch.",
    category: "Commit",
    capability: "cherryPick",
    shape: { hashes: z.array(hashArg).min(1).max(500), noCommit: z.boolean().optional(), recordOrigin: z.boolean().optional(), mainline: z.number().int().min(1).optional() },
    contexts: ["commit"],
  },
  {
    op: "revert",
    title: "Revert commit",
    description: "Create a new commit that undoes a commit.",
    category: "Commit",
    capability: "revert",
    shape: { hash: hashArg, mainline: z.number().int().min(1).optional() },
    contexts: ["commit"],
  },
  {
    op: "reset",
    title: "Reset current branch",
    description: "Move the current branch to a commit (soft, mixed or hard).",
    category: "Branch",
    capability: "reset",
    shape: { target: refish, mode: z.enum(["soft", "mixed", "hard"]) },
    contexts: ["commit"],
    consequence: (a) =>
      a.mode === "hard"
        ? `Hard reset the current branch to ${a.target}. ALL uncommitted changes to tracked files are permanently discarded.`
        : `${a.mode === "soft" ? "Soft" : "Mixed"} reset the current branch to ${a.target}. Commits after it leave the branch (recoverable via reflog); ${
            a.mode === "soft" ? "their changes stay staged." : "their changes stay in the working tree, unstaged."
          }`,
  },
  {
    op: "operation.continue",
    title: "Continue operation",
    description: "Continue the in-progress merge, rebase, cherry-pick or revert.",
    category: "Working Tree",
    capability: "conflicts",
    shape: {},
  },
  {
    op: "operation.skip",
    title: "Skip current step",
    description: "Skip the current commit of an in-progress rebase or cherry-pick.",
    category: "Working Tree",
    capability: "conflicts",
    shape: {},
    consequence: () => "Skip the current commit of the in-progress operation. Its changes are dropped from the result.",
  },
  {
    op: "operation.abort",
    title: "Abort operation",
    description: "Abort the in-progress merge, rebase, cherry-pick or revert and restore the pre-operation state.",
    category: "Working Tree",
    capability: "conflicts",
    shape: {},
    consequence: () => "Abort the in-progress operation. Conflict resolutions made so far are discarded and the branch returns to its previous state.",
  },
  { op: "stage", title: "Stage files", description: "Add files to the index.", category: "Working Tree", capability: "stage", shape: { paths: z.array(pathArg).min(1) }, contexts: ["file"] },
  { op: "unstage", title: "Unstage files", description: "Remove files from the index, keeping working-tree changes.", category: "Working Tree", capability: "stage", shape: { paths: z.array(pathArg).min(1) }, contexts: ["file"] },
  {
    op: "stage.patch",
    title: "Stage hunk",
    description: "Apply a unified-diff patch (one or more hunks) to the index. reverse=true unstages it.",
    category: "Working Tree",
    capability: "stageHunk",
    shape: { patch: z.string().min(1).max(5_000_000), reverse: z.boolean().optional() },
    contexts: ["diff"],
  },
  {
    op: "discard.patch",
    title: "Discard hunk",
    description: "Reverse-apply a patch to the working tree, discarding those changes.",
    category: "Working Tree",
    capability: "stageHunk",
    shape: { patch: z.string().min(1).max(5_000_000) },
    contexts: ["diff"],
    consequence: (a) => `Discard ${(a.patch.match(/^@@/gm) ?? []).length} hunk(s) from the working tree. These edits are permanently lost.`,
  },
  {
    op: "restore",
    title: "Restore files",
    description: "Restore files in the index and/or working tree from a source (default HEAD / index).",
    category: "Working Tree",
    capability: "stage",
    shape: { paths: z.array(pathArg).min(1), source: refish.optional(), staged: z.boolean().optional(), worktree: z.boolean().optional() },
    contexts: ["file"],
    consequence: (a) =>
      a.worktree === false
        ? null
        : `Discard working-tree changes to ${a.paths.length === 1 ? `"${a.paths[0]}"` : `${a.paths.length} files`}${a.source ? ` (restoring from ${a.source})` : ""}. These edits are permanently lost.`,
  },
  {
    op: "commit",
    title: "Commit",
    description: "Commit the staged changes. Hooks and signing configuration are respected.",
    category: "Working Tree",
    capability: "commitWrite",
    shape: { message: z.string().max(100_000), amend: z.boolean().optional(), signoff: z.boolean().optional(), allowEmpty: z.boolean().optional() },
    consequence: (a) => (a.amend ? "Amend replaces the current HEAD commit with a new one (new hash). Do not amend commits that were already pushed." : null),
  },
  {
    op: "stash.push",
    title: "Stash changes",
    description: "Stash uncommitted changes, optionally only selected paths or only staged changes.",
    category: "Stash",
    capability: "stash",
    shape: {
      message: z.string().max(1000).optional(),
      paths: z.array(pathArg).optional(),
      includeUntracked: z.boolean().optional(),
      keepIndex: z.boolean().optional(),
      staged: z.boolean().optional(),
    },
    contexts: ["uncommitted"],
  },
  { op: "stash.apply", title: "Apply stash", description: "Apply a stash, keeping it.", category: "Stash", capability: "stash", shape: { index: z.number().int().min(0), reinstateIndex: z.boolean().optional() }, contexts: ["stash"] },
  { op: "stash.pop", title: "Pop stash", description: "Apply a stash and drop it if it applied cleanly.", category: "Stash", capability: "stash", shape: { index: z.number().int().min(0), reinstateIndex: z.boolean().optional() }, contexts: ["stash"] },
  {
    op: "stash.drop",
    title: "Drop stash",
    description: "Delete a stash entry.",
    category: "Stash",
    capability: "stash",
    shape: { index: z.number().int().min(0) },
    contexts: ["stash"],
    consequence: (a) => `Drop stash@{${a.index}}. Its changes are only recoverable by hash until garbage collection.`,
  },
  { op: "stash.branch", title: "Create branch from stash", description: "Create and check out a branch from a stash.", category: "Stash", capability: "stash", shape: { index: z.number().int().min(0), name: refish }, contexts: ["stash"] },
  {
    op: "fetch",
    title: "Fetch",
    description: "Fetch from one or all remotes. Never touches the working tree.",
    category: "Remote",
    capability: "fetch",
    shape: { remote: refish.optional(), prune: z.boolean().optional(), pruneTags: z.boolean().optional() },
  },
  {
    op: "pull",
    title: "Pull",
    description: "Fetch and integrate the upstream of the current branch.",
    category: "Remote",
    capability: "pull",
    shape: { remote: refish.optional(), branch: refish.optional(), rebase: z.boolean().optional(), ffOnly: z.boolean().optional() },
  },
  {
    op: "push",
    title: "Push",
    description: "Push a branch. Force pushes always use --force-with-lease.",
    category: "Remote",
    capability: "push",
    shape: { remote: refish, branch: refish, setUpstream: z.boolean().optional(), forceWithLease: z.object({ expect: hashArg.optional() }).optional() },
    contexts: ["ref"],
    consequence: (a) =>
      a.forceWithLease
        ? `Force-push "${a.branch}" to "${a.remote}" with --force-with-lease${a.forceWithLease.expect ? ` (only if the remote is still at ${short(a.forceWithLease.expect)})` : ""}. Remote commits not in your branch are discarded from it.`
        : null,
  },
  { op: "remote.add", title: "Add remote", description: "Add a remote.", category: "Remote", capability: "remotes", shape: { name: refish, url: z.string().min(1).max(2000) } },
  {
    op: "remote.remove",
    title: "Remove remote",
    description: "Remove a remote and its remote-tracking branches.",
    category: "Remote",
    capability: "remotes",
    shape: { name: refish },
    consequence: (a) => `Remove remote "${a.name}" and delete all refs/remotes/${a.name}/* tracking branches.`,
  },
  { op: "remote.rename", title: "Rename remote", description: "Rename a remote.", category: "Remote", capability: "remotes", shape: { from: refish, to: refish } },
  { op: "remote.set-url", title: "Set remote URL", description: "Change a remote's URL.", category: "Remote", capability: "remotes", shape: { name: refish, url: z.string().min(1).max(2000) } },
  {
    op: "upstream.set",
    title: "Set upstream",
    description: "Set or unset the upstream of a local branch.",
    category: "Remote",
    capability: "remotes",
    shape: { branch: refish, upstream: refish.nullable() },
    contexts: ["ref"],
  },
  {
    op: "worktree.add",
    title: "Create worktree",
    description: "Create a linked worktree at a path, for an existing or new branch.",
    category: "Worktree",
    capability: "worktrees",
    shape: { path: pathArg, branch: refish.optional(), newBranch: refish.optional(), commitish: refish.optional() },
    contexts: ["ref", "commit"],
  },
  {
    op: "worktree.remove",
    title: "Remove worktree",
    description: "Remove a linked worktree.",
    category: "Worktree",
    capability: "worktrees",
    shape: { path: pathArg, force: z.boolean().optional() },
    contexts: ["worktree"],
    consequence: (a) => `Remove the worktree at "${a.path}".${a.force ? " Force: uncommitted changes in it are permanently lost." : " Git refuses if it has uncommitted changes."}`,
  },
  { op: "worktree.lock", title: "Lock worktree", description: "Prevent a worktree from being pruned.", category: "Worktree", capability: "worktrees", shape: { path: pathArg, reason: z.string().max(500).optional() }, contexts: ["worktree"] },
  { op: "worktree.unlock", title: "Unlock worktree", description: "Allow a worktree to be pruned.", category: "Worktree", capability: "worktrees", shape: { path: pathArg }, contexts: ["worktree"] },
  {
    op: "worktree.prune",
    title: "Prune worktrees",
    description: "Remove administrative data for worktrees whose directories are gone.",
    category: "Worktree",
    capability: "worktrees",
    shape: { dryRun: z.boolean().optional() },
    consequence: (a) => (a.dryRun ? null : "Prune administrative data of worktrees whose directories no longer exist."),
  },
  {
    op: "conflict.resolve",
    title: "Resolve conflict",
    description: "Resolve a conflicted file with ours, theirs or explicit content, then stage it.",
    category: "Working Tree",
    capability: "conflicts",
    shape: { path: pathArg, resolution: z.union([z.enum(["ours", "theirs"]), z.object({ content: z.string().max(20_000_000) })]) },
    contexts: ["file"],
    consequence: (a) => `Overwrite "${a.path}" with ${typeof a.resolution === "string" ? `the "${a.resolution}" version` : "the edited content"} and stage it.`,
  },
  {
    op: "clean",
    title: "Clean untracked files",
    description: "Delete untracked files. Run with dryRun=true first to preview the exact list.",
    category: "Working Tree",
    capability: "clean",
    shape: { paths: z.array(pathArg).min(1), dryRun: z.boolean(), directories: z.boolean().optional() },
    consequence: (a) => (a.dryRun ? null : `Permanently delete ${a.paths.length} untracked path(s): ${a.paths.slice(0, 10).join(", ")}${a.paths.length > 10 ? ", …" : ""}.`),
  },
  {
    op: "git.run",
    title: "Run Git command…",
    description: "Run an arbitrary git command in the selected worktree (local companion only).",
    category: "Repository",
    capability: "runGit",
    shape: { args: z.array(z.string().max(10000)).min(1).max(200) },
    consequence: (a) => `Run "git ${a.args.join(" ")}" in the selected worktree. Its effect is not previewed.`,
  },
];

function opToId(op: string): string {
  return `git.${op}`;
}

const mutations: AnyCommand[] = mutationSpecs.map((s) =>
  defineCommand({
    id: opToId(s.op),
    title: s.title,
    description: s.description,
    category: s.category,
    kind: "mutation",
    capability: s.capability,
    contexts: s.contexts,
    args: z.object({ repo: repoArg.optional(), precondition, ...s.shape }),
    destructive: s.consequence,
    execute: async (a: Record<string, any>, ctx) => {
      const repo = await resolveRepo(ctx, a.repo);
      const { repo: _r, precondition: pre, ...rest } = a;
      const m = { op: s.op, ...rest } as GitMutation;
      return repo.mutate(m, pre as MutationPrecondition | undefined);
    },
  }),
);

export function mutationCommandId(op: GitMutation["op"]): string {
  return opToId(op);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const links: AnyCommand[] = [
  defineCommand({
    id: "link.build",
    title: "Build deep link",
    description: "Build a canonical URL to a repository view: branch filter, focused branch, commit, comparison, file and diff.",
    category: "Links",
    kind: "query",
    args: z.object({
      repo: repoArg,
      worktree: z.string().optional(),
      branches: z.array(refish).optional(),
      focusBranch: refish.optional(),
      commit: z.string().optional(),
      compare: z.string().optional(),
      select: z.array(z.string()).optional(),
      file: pathArg.optional(),
      view: z.enum(["graph", "details", "diff"]).optional(),
      q: z.string().max(200).optional(),
    }),
    execute: (a, ctx) => {
      const ref = parseRepoKey(a.repo);
      if (!ref) throw new AppError("BAD_REQUEST", `Invalid repository key "${a.repo}"`);
      const commit = a.commit ? normalizeHash(a.commit) : null;
      if (a.commit && !commit) throw new AppError("BAD_REQUEST", `Invalid commit "${a.commit}"`);
      const compare = a.compare ? normalizeHash(a.compare) : null;
      if (a.compare && !compare) throw new AppError("BAD_REQUEST", `Invalid compare "${a.compare}"`);
      const state: ViewState = {
        ...EMPTY_VIEW,
        repo: ref,
        worktree: a.worktree ?? null,
        branches: a.branches ?? [],
        focusBranch: a.focusBranch ?? null,
        commit,
        compare: commit ? compare : null,
        selected: (a.select ?? []).map((s: string) => normalizeHash(s)).filter((h: string | null): h is string => !!h && h !== commit),
        file: a.file ?? null,
        view: a.view ?? (commit ? (a.file ? "diff" : "details") : "graph"),
        q: a.q ?? "",
        display: DEFAULT_DISPLAY,
      };
      return { url: buildUrl(ctx.appOrigin, state) };
    },
  }),
];

export function repoCommands(): AnyCommand[] {
  return [...queries, ...mutations, ...links];
}

export function createRepoRegistry(): CommandRegistry {
  return new CommandRegistry().register(...repoCommands());
}
