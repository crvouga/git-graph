// Companion-level commands (not bound to an existing repository): open, clone and init local
// repositories. Registered in the same registry as the repo commands, so they appear in
// /api/v1/commands, the CLI and MCP.

import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { AppError } from "../core/types.ts";
import { defineCommand, type AnyCommand, type CommandRegistry } from "../core/commands/registry.ts";
import { createRepoRegistry } from "../core/commands/repo-commands.ts";
import { gitFailure, requireGit, runGit } from "./exec.ts";
import type { LocalRepos } from "./local-repos.ts";

const absPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !s.includes("\0"), "must not contain NUL")
  .describe("Absolute filesystem path (relative paths resolve against the companion's working directory)");

async function emptyOrMissing(p: string): Promise<boolean> {
  const st = await stat(p).catch(() => null);
  if (!st) return true;
  if (!st.isDirectory()) return false;
  return (await readdir(p)).length === 0;
}

export function companionCommands(local: LocalRepos): AnyCommand[] {
  return [
    defineCommand({
      id: "local.open",
      title: "Open local repository",
      description: "Register a local worktree with the companion (any path inside it) and return its repository info and key.",
      category: "Repository",
      kind: "query",
      args: z.object({ path: absPath }),
      execute: async (a) => local.open(isAbsolute(a.path) ? a.path : resolve(a.path)),
    }),
    defineCommand({
      id: "local.clone",
      title: "Clone repository",
      description: "Clone a remote repository into a new local directory and open it. Uses your Git credential helpers and SSH agent.",
      category: "Repository",
      kind: "mutation",
      args: z.object({
        url: z
          .string()
          .min(1)
          .max(2000)
          .refine((s) => !s.startsWith("-"), "must not start with '-'"),
        path: absPath,
      }),
      execute: async (a) => {
        await requireGit();
        const target = resolve(a.path);
        if (!(await emptyOrMissing(target))) throw new AppError("BAD_REQUEST", `Destination "${target}" exists and is not an empty directory`);
        await mkdir(dirname(target), { recursive: true });
        const r = await runGit(["clone", "--", a.url, target], { cwd: dirname(target) });
        if (r.code !== 0) throw gitFailure(r);
        const info = await local.open(target);
        return { ...info, output: (r.stdout + r.stderr).trim(), invocations: [r.invocation] };
      },
    }),
    defineCommand({
      id: "local.init",
      title: "Initialize repository",
      description: "Create an empty Git repository in a directory and open it.",
      category: "Repository",
      kind: "mutation",
      args: z.object({ path: absPath, initialBranch: z.string().min(1).max(255).refine((s) => !s.startsWith("-")).optional() }),
      execute: async (a) => {
        await requireGit();
        const target = resolve(a.path);
        await mkdir(target, { recursive: true });
        const r = await runGit(["init", ...(a.initialBranch ? [`--initial-branch=${a.initialBranch}`] : []), "--", target], { cwd: target });
        if (r.code !== 0) throw gitFailure(r);
        const info = await local.open(target);
        return { ...info, output: (r.stdout + r.stderr).trim(), invocations: [r.invocation] };
      },
    }),
  ];
}

/** The full companion registry: repository commands + companion commands. */
export function createCompanionRegistry(local: LocalRepos): CommandRegistry {
  return createRepoRegistry().register(...companionCommands(local));
}
