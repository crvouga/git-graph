// Deterministic, disposable Git fixtures. All mutations stay under .fixtures/ (gitignored).
//
//   node test/fixtures/make-fixtures.ts            # basic fixture set
//   node test/fixtures/make-fixtures.ts --large    # also the 100k-commit history
//
// Git config is isolated ONLY for fixture creation (fixed identity, dates, no signing) so the
// fixtures are byte-for-byte reproducible. Production code always respects the user's config.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../.fixtures");

let clock = 1_700_000_000; // 2023-11-14T22:13:20Z
function tick(sec = 3600) {
  clock += sec;
  return `${clock} +0000`;
}

const AUTHORS = [
  ["Ada Lovelace", "ada@example.com"],
  ["Grace Hopper", "grace@example.com"],
  ["Linus Example", "linus@example.com"],
] as const;

export function fixtureEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: ROOT,
    GIT_CONFIG_GLOBAL: join(ROOT, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C.UTF-8",
    TZ: "UTC",
    ...extra,
  };
}

function git(cwd: string, args: string[], opts: { author?: number; input?: string; allowFail?: boolean } = {}): string {
  const [name, email] = AUTHORS[opts.author ?? 0]!;
  const date = tick();
  try {
    return execFileSync("git", args, {
      cwd,
      input: opts.input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: fixtureEnv({
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
        GIT_COMMITTER_DATE: date,
      }),
    });
  } catch (e) {
    if (opts.allowFail) return "";
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${err.stderr ?? err.message}`);
  }
}

function write(dir: string, rel: string, content: string | Uint8Array) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function commitAll(dir: string, msg: string, author = 0) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", msg], { author });
}

function binary(seed: number, size = 600): Uint8Array {
  const b = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    b[i] = x & 0xff;
  }
  b[0] = 0; // guarantees binary detection
  return b;
}

export interface BasicFixture {
  repo: string;
  remote: string;
  worktreeFeature: string;
  worktreeTwo: string;
}

export function makeBasic(root = ROOT): BasicFixture {
  const repo = join(root, "basic");
  const remote = join(root, "basic-remote.git");
  const wtFeature = join(root, "basic wt feature"); // space on purpose
  const wtTwo = join(root, "basic-wt-two");
  for (const p of [repo, remote, wtFeature, wtTwo, join(root, "tmp-clone")]) rmSync(p, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ".gitconfig"), "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n");

  git(root, ["init", "-q", "--bare", remote]);
  git(root, ["init", "-q", repo]);

  // main: initial history
  write(repo, "README.md", "# Fixture\n\nA deterministic repository.\n");
  write(repo, "src/app.ts", Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join("\n") + "\n");
  write(repo, "docs/old.md", "Old docs\n");
  write(repo, "docs/my file.md", "A file with a space in its name\n");
  write(repo, "assets/logo.bin", binary(1));
  write(repo, "conflict.txt", "line 1\nshared line\nline 3\n");
  commitAll(repo, "Initial commit");

  write(repo, "src/util.ts", "export function add(a: number, b: number) {\n  return a + b;\n}\n");
  commitAll(repo, "Add util module", 1);
  const c2 = git(repo, ["rev-parse", "HEAD"]).trim();

  // feature/auth from c2
  git(repo, ["checkout", "-q", "-b", "feature/auth"]);
  write(repo, "src/auth.ts", "export const login = () => true;\n");
  commitAll(repo, "Add login stub", 2);
  write(repo, "src/auth.ts", "export const login = () => true;\nexport const logout = () => false;\n");
  commitAll(repo, "Add logout", 2);

  git(repo, ["checkout", "-q", "main"]);
  write(repo, "README.md", "# Fixture\n\nA deterministic repository.\n\n## Usage\n\nRun it.\n");
  commitAll(repo, "Document usage");
  const c3 = git(repo, ["rev-parse", "HEAD"]).trim();
  // Multiple refs on one commit: annotated tag, lightweight tag and a branch.
  git(repo, ["tag", "-a", "v1.0", "-m", "Release 1.0"]);
  git(repo, ["tag", "v1.0-lw"]);
  git(repo, ["branch", "release/1.0"]);

  // develop from c3, merges feature/auth with a merge commit
  git(repo, ["checkout", "-q", "-b", "develop"]);
  write(repo, "src/dev.ts", "export const dev = true;\n");
  commitAll(repo, "Start develop", 1);
  git(repo, ["merge", "-q", "--no-ff", "-m", "Merge branch 'feature/auth' into develop", "feature/auth"], { author: 1 });

  // main continues: rename, delete, binary change
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["mv", "src/app.ts", "src/main.ts"]);
  git(repo, ["commit", "-q", "-m", "Rename app.ts to main.ts"]);
  git(repo, ["rm", "-q", "docs/old.md"]);
  write(repo, "assets/logo.bin", binary(2));
  commitAll(repo, "Remove old docs and update logo");

  // conflicting branches
  git(repo, ["checkout", "-q", "-b", "conflict-a"]);
  write(repo, "conflict.txt", "line 1\nchanged by A\nline 3\n");
  commitAll(repo, "Conflict side A", 1);
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["checkout", "-q", "-b", "conflict-b"]);
  write(repo, "conflict.txt", "line 1\nchanged by B\nline 3\n");
  commitAll(repo, "Conflict side B", 2);
  git(repo, ["checkout", "-q", "main"]);

  // disconnected history
  git(repo, ["checkout", "-q", "--orphan", "gh-pages"]);
  git(repo, ["rm", "-rfq", "."]);
  write(repo, "index.html", "<h1>Pages</h1>\n");
  commitAll(repo, "Pages root", 2);
  write(repo, "index.html", "<h1>Pages v2</h1>\n");
  commitAll(repo, "Update pages", 2);
  git(repo, ["checkout", "-q", "main"]);

  // remote: push branches + tag, then create a remote-only branch from another clone
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-q", "-u", "origin", "main", "develop", "feature/auth"]);
  git(repo, ["push", "-q", "origin", "v1.0"]);
  const clone = join(root, "tmp-clone");
  git(root, ["clone", "-q", remote, clone]);
  git(clone, ["checkout", "-q", "-b", "hotfix/urgent", "origin/main"]);
  write(clone, "HOTFIX.md", "urgent\n");
  commitAll(clone, "Urgent hotfix", 1);
  git(clone, ["push", "-q", "origin", "hotfix/urgent"]);
  rmSync(clone, { recursive: true, force: true });
  git(repo, ["fetch", "-q", "origin"]);
  git(repo, ["remote", "set-head", "origin", "main"]);

  // local main ahead of origin by one commit
  write(repo, "src/util.ts", "export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function sub(a: number, b: number) {\n  return a - b;\n}\n");
  commitAll(repo, "Add sub()", 0);

  // stash
  write(repo, "src/util.ts", "// stashed edit\n" + "export function add(a: number, b: number) {\n  return a + b;\n}\n");
  git(repo, ["stash", "push", "-q", "-m", "WIP: experiment with util"]);

  // linked worktrees
  git(repo, ["worktree", "add", "-q", wtFeature, "feature/auth"]);
  git(repo, ["worktree", "add", "-q", "-b", "wt-two", wtTwo, "main~1"]);

  // working-tree state: staged, unstaged (2 hunks), untracked with tricky names
  write(repo, "README.md", "# Fixture\n\nA deterministic repository (staged edit).\n\n## Usage\n\nRun it.\n");
  git(repo, ["add", "README.md"]);
  const main = Array.from({ length: 40 }, (_, i) => (i === 2 ? "export const line2 = 'two';" : i === 35 ? "export const line35 = 'thirty-five';" : `export const line${i} = ${i};`));
  write(repo, "src/main.ts", main.join("\n") + "\n");
  write(repo, "notes with space.txt", "untracked\n");
  write(repo, "ünïcødé.txt", "unicode name\n");
  write(repo, "-dash.txt", "leading dash\n");

  void c2;
  void c3;
  return { repo, remote, worktreeFeature: wtFeature, worktreeTwo: wtTwo };
}

/** A small repo whose working tree is mid-merge with a conflict. */
export function makeConflict(root = ROOT): string {
  const repo = join(root, "conflict");
  rmSync(repo, { recursive: true, force: true });
  git(root, ["init", "-q", repo]);
  write(repo, "file.txt", "a\nb\nc\n");
  commitAll(repo, "base");
  git(repo, ["checkout", "-q", "-b", "other"]);
  write(repo, "file.txt", "a\nB-other\nc\n");
  commitAll(repo, "other change");
  git(repo, ["checkout", "-q", "main"]);
  write(repo, "file.txt", "a\nB-main\nc\n");
  commitAll(repo, "main change");
  git(repo, ["merge", "other"], { allowFail: true });
  return repo;
}

/**
 * 100k+ commit history generated with git fast-import: a mainline with periodic feature
 * branches merged back, plus long-lived release branches and tags.
 */
export async function makeLarge(count = 100_000, root = ROOT): Promise<string> {
  const repo = join(root, `large-${count}`);
  const marker = join(repo, ".git", "fixture-complete");
  if (existsSync(marker)) return repo;
  rmSync(repo, { recursive: true, force: true });
  git(root, ["init", "-q", repo]);
  const child = spawn("git", ["fast-import", "--quiet", "--done"], { cwd: repo, env: fixtureEnv(), stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise<void>((res, rej) => child.on("exit", (c) => (c === 0 ? res() : rej(new Error(`fast-import exited ${c}`)))));
  let buf = "";
  const flush = async (force = false) => {
    if (buf.length > 1 << 20 || force) {
      const ok = child.stdin.write(buf);
      buf = "";
      if (!ok) await new Promise((r) => child.stdin.once("drain", r));
    }
  };
  let t = 1_500_000_000;
  let mark = 0;
  const commit = (ref: string, msg: string, parents: number[], file: string) => {
    mark++;
    t += 60;
    const [name, email] = AUTHORS[mark % AUTHORS.length]!;
    const data = `${msg}\n`;
    const content = `${mark}\n`;
    buf += `commit ${ref}\nmark :${mark}\nauthor ${name} <${email}> ${t} +0000\ncommitter ${name} <${email}> ${t} +0000\ndata ${Buffer.byteLength(data)}\n${data}`;
    if (parents.length) {
      buf += `from :${parents[0]}\n`;
      for (const p of parents.slice(1)) buf += `merge :${p}\n`;
    }
    buf += `M 644 inline ${file}\ndata ${content.length}\n${content}\n`;
    return mark;
  };
  let mainTip = commit("refs/heads/main", "Initial commit", [], "main.txt");
  let produced = 1;
  let feature = 0;
  const releases: number[] = [];
  while (produced < count) {
    // a feature branch of 1-6 commits merged back into main
    const len = 1 + (feature % 6);
    const fname = `feature/f${feature}`;
    let fTip = mainTip;
    const mainAdvance = feature % 3;
    for (let i = 0; i < len && produced < count; i++, produced++) fTip = commit(`refs/heads/${fname}`, `Feature ${feature} step ${i}`, [fTip], `f${feature % 50}.txt`);
    for (let i = 0; i < mainAdvance && produced < count; i++, produced++) mainTip = commit("refs/heads/main", `Main work ${produced}`, [mainTip], "main.txt");
    if (produced < count) {
      mainTip = commit("refs/heads/main", `Merge branch '${fname}'`, [mainTip, fTip], "main.txt");
      produced++;
    }
    // Keep only the most recent 30 feature branches as live refs.
    if (feature >= 30) buf += `reset refs/heads/feature/f${feature - 30}\nfrom 0000000000000000000000000000000000000000\n\n`;
    if (feature % 500 === 0) {
      releases.push(mainTip);
      buf += `reset refs/tags/v${releases.length}.0\nfrom :${mainTip}\n\n`;
    }
    feature++;
    await flush();
  }
  buf += "done\n";
  await flush(true);
  child.stdin.end();
  await done;
  // fast-import cannot delete refs via reset-to-zero on all versions; prune stale feature refs explicitly.
  const refs = git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/feature/"]).split("\n").filter(Boolean);
  const keep = new Set(Array.from({ length: 30 }, (_, i) => `refs/heads/feature/f${feature - 1 - i}`));
  const del = refs.filter((r) => !keep.has(r));
  if (del.length) git(repo, ["update-ref", "--stdin"], { input: del.map((r) => `delete ${r}\n`).join("") });
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(repo, ["checkout", "-q", "-f", "main"]);
  writeFileSync(marker, String(count));
  return repo;
}

/** Copy of basic with everything packed (exercises packfile + delta readers). */
export function makePacked(root = ROOT): string {
  const src = join(root, "basic");
  const repo = join(root, "packed");
  rmSync(repo, { recursive: true, force: true });
  git(root, ["clone", "-q", "--mirror", src, join(repo, ".git")]);
  git(repo, ["config", "--bool", "core.bare", "false"]);
  git(repo, ["gc", "-q", "--aggressive", "--prune=now"]);
  return repo;
}

function cleanupStale(root: string) {
  for (const f of ["tmp-clone"]) rmSync(join(root, f), { recursive: true, force: true });
  void renameSync;
  void unlinkSync;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = performance.now();
  const b = makeBasic();
  makeConflict();
  makePacked();
  cleanupStale(ROOT);
  console.log(JSON.stringify({ ...b, ms: Math.round(performance.now() - t0) }));
  if (process.argv.includes("--large")) {
    const n = Number(process.argv[process.argv.indexOf("--large") + 1]) || 100_000;
    const t1 = performance.now();
    const p = await makeLarge(n);
    console.log(JSON.stringify({ large: p, ms: Math.round(performance.now() - t1) }));
  }
}
