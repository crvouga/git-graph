// Locates the git directory inside a picked folder: "<root>/.git" (directory), a ".git" file
// ("gitdir: ..." — linked worktree / submodule), or the picked folder itself (bare repo or a .git dir).

import { AppError } from "../core/types.ts";
import { GitConfig } from "./config.ts";
import { joinPath, type DirSource } from "./source.ts";

export const READ_ONLY_REASON =
  "Opened through browser file access (read-only). Run `git-graph open .` to use the local companion for full Git functionality.";

export interface GitLayout {
  /** Per-worktree git dir (holds HEAD), relative to the picked root ("" = the root itself). */
  gitDir: string;
  /** Shared git dir (objects, refs, packed-refs, config). */
  commonDir: string;
  /** No working tree in the picked folder. */
  bare: boolean;
  config: GitConfig;
}

const OUTSIDE_MESSAGE =
  "This folder's Git data lives outside the folder you picked (it is a linked worktree or a submodule). " +
  "Open the main repository folder instead, or run `git-graph open .` in a terminal to use the local companion.";

export async function resolveGitLayout(src: DirSource): Promise<GitLayout> {
  const rootEntries = (await src.list("")) ?? [];
  const dotGit = rootEntries.find((e) => e.name === ".git");
  let gitDir: string;
  let bare = false;
  if (dotGit?.kind === "directory") {
    gitDir = ".git";
  } else if (dotGit?.kind === "file") {
    const text = (await src.readText(".git")) ?? "";
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!m) throw new AppError("BAD_REQUEST", "The .git file in this folder is not a valid gitdir pointer.");
    const target = m[1]!;
    const resolved = isAbsolute(target) ? null : joinPath("", target);
    if (resolved === null) throw new AppError("UNSUPPORTED", OUTSIDE_MESSAGE, { gitdir: target });
    gitDir = resolved;
  } else if (rootEntries.some((e) => e.name === "HEAD" && e.kind === "file") && rootEntries.some((e) => e.name === "objects" || e.name === "commondir")) {
    gitDir = "";
    bare = true;
  } else {
    throw new AppError("NOT_FOUND", "The selected folder is not a Git repository (no .git directory found). Pick the repository's top-level folder.");
  }

  const head = await src.readText(joinPath(gitDir, "HEAD")!);
  if (head === null) throw new AppError("NOT_FOUND", "The Git directory is missing its HEAD file.");

  let commonDir = gitDir;
  const commondirText = await src.readText(joinPath(gitDir, "commondir")!);
  if (commondirText !== null) {
    const target = commondirText.trim();
    const resolved = isAbsolute(target) ? null : joinPath(gitDir, target);
    if (resolved === null) throw new AppError("UNSUPPORTED", OUTSIDE_MESSAGE, { commondir: target });
    commonDir = resolved;
  }

  const config = GitConfig.parse((await src.readText(joinPath(commonDir, "config")!)) ?? "");
  const format = config.get("extensions.objectformat");
  if (format && format.toLowerCase() !== "sha1") {
    throw new AppError("UNSUPPORTED", `This repository uses the ${format} object format, which browser file access does not support yet. Run \`git-graph open .\` to use the local companion.`, { objectFormat: format });
  }
  const refStorage = config.get("extensions.refstorage");
  if (refStorage && refStorage.toLowerCase() !== "files") {
    throw new AppError("UNSUPPORTED", `This repository stores refs as ${refStorage}, which browser file access does not support. Run \`git-graph open .\` to use the local companion.`, { refStorage });
  }
  return { gitDir, commonDir, bare, config };
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}
