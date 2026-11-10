import { describe, expect, it } from "vitest";
import {
  LogStreamParser,
  combineDiff,
  hash64,
  hunkPatch,
  parseBlamePorcelain,
  parseForEachRef,
  parseLog,
  parsePatch,
  parseRawNumstat,
  parseStashList,
  parseStatusV2,
  parseTrack,
  parseUnifiedDiff,
  parseWorktreeList,
  refsDigest,
  scrubText,
  scrubUrl,
  unquoteCPath,
} from "../../src/core/git/index.ts";
import type { Ref } from "../../src/core/types.ts";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const H3 = "3".repeat(40);

function rec(hash: string, parents: string[], subject: string, name = "Ada Lövelace") {
  return [hash, parents.join(" "), name, "ada@example.com", "1700000000", "Grace", "grace@example.com", "1700000100", subject].join("\0") + "\0";
}

describe("log parser", () => {
  const text = rec(H1, [H2, H3], "Merge ünïcode") + rec(H2, [H3], "two") + rec(H3, [], "root: with\ttab");

  it("parses complete output", () => {
    const cs = parseLog(text);
    expect(cs).toHaveLength(3);
    expect(cs[0]).toEqual({
      hash: H1,
      parents: [H2, H3],
      author: { name: "Ada Lövelace", email: "ada@example.com", date: 1700000000 },
      committer: { name: "Grace", email: "grace@example.com", date: 1700000100 },
      subject: "Merge ünïcode",
    });
    expect(cs[2]!.parents).toEqual([]);
    expect(cs[2]!.subject).toBe("root: with\ttab");
  });

  it("is chunk-boundary independent (multi-byte UTF-8 split anywhere)", () => {
    const bytes = new TextEncoder().encode(text);
    for (const size of [1, 2, 3, 7, 64]) {
      const p = new LogStreamParser();
      const out = [];
      for (let i = 0; i < bytes.length; i += size) out.push(...p.push(bytes.subarray(i, i + size)));
      expect(out.map((c) => c.subject)).toEqual(["Merge ünïcode", "two", "root: with\ttab"]);
      expect(out[0]!.author.name).toBe("Ada Lövelace");
      expect(p.clean).toBe(true);
    }
  });
});

describe("for-each-ref parser", () => {
  const line = (f: string[]) => f.join("\0");
  const out = [
    line(["refs/heads/main", H1, "", "refs/remotes/origin/main", "[ahead 2, behind 1]", "/repo", "", "commit"]),
    line(["refs/heads/synced", H1, "", "refs/remotes/origin/synced", "", "", "", "commit"]),
    line(["refs/heads/orphaned", H1, "", "refs/remotes/origin/gone", "[gone]", "", "", "commit"]),
    line(["refs/remotes/origin/HEAD", H1, "", "", "", "", "refs/remotes/origin/main", "commit"]),
    line(["refs/remotes/my/fork/feature", H2, "", "", "", "", "", "commit"]),
    line(["refs/tags/v1", H3, H2, "", "", "", "", "tag"]),
    line(["refs/stash", H3, "", "", "", "", "", "commit"]),
    line(["refs/notes/commits", H3, "", "", "", "", "", "commit"]),
  ].join("\n");

  it("parses kinds, upstream tracking, worktrees, symrefs and peeled tags", () => {
    const refs = parseForEachRef(out, { remoteNames: ["origin", "my/fork"], withTrack: true });
    expect(refs.map((r) => r.short)).toEqual(["main", "synced", "orphaned", "origin/HEAD", "my/fork/feature", "v1"]);
    const [main, synced, orphaned, head, fork, tag] = refs as [Ref, Ref, Ref, Ref, Ref, Ref];
    expect(main).toMatchObject({ kind: "head", upstream: "refs/remotes/origin/main", ahead: 2, behind: 1, checkedOutAt: "/repo", commit: H1 });
    expect(synced).toMatchObject({ ahead: 0, behind: 0 });
    expect(orphaned.ahead).toBeUndefined();
    expect(head).toMatchObject({ kind: "remote", remote: "origin", symbolicTarget: "refs/remotes/origin/main" });
    expect(fork.remote).toBe("my/fork");
    expect(tag).toMatchObject({ kind: "tag", target: H3, commit: H2 });
  });

  it("omits ahead/behind without tracking info", () => {
    const refs = parseForEachRef(out);
    expect(refs[0]!.ahead).toBeUndefined();
  });

  it("parses tracking strings", () => {
    expect(parseTrack("[ahead 3]")).toEqual({ ahead: 3, behind: 0, gone: false });
    expect(parseTrack("[behind 4]")).toEqual({ ahead: 0, behind: 4, gone: false });
    expect(parseTrack("")).toBeNull();
  });

  it("parses stash reflog", () => {
    const s = parseStashList(`${H1}\0refs/stash@{0}\0On main: WIP\0\n${H2}\0refs/stash@{1}\0WIP on dev: abc\0`);
    expect(s).toEqual([
      { name: "refs/stash@{0}", kind: "stash", short: "stash@{0}", target: H1, commit: H1, message: "On main: WIP" },
      { name: "refs/stash@{1}", kind: "stash", short: "stash@{1}", target: H2, commit: H2, message: "WIP on dev: abc" },
    ]);
  });
});

describe("refs digest", () => {
  const a: Ref = { name: "refs/heads/a", kind: "head", short: "a", target: H1, commit: H1 };
  const b: Ref = { name: "refs/heads/b", kind: "head", short: "b", target: H2, commit: H2 };
  const head = { kind: "branch", ref: "refs/heads/a", commit: H1 } as const;
  it("is deterministic and order-insensitive", () => {
    expect(refsDigest(head, [a, b])).toBe(refsDigest(head, [b, a]));
    expect(refsDigest(head, [a, b])).toMatch(/^[0-9a-f]{16}$/);
  });
  it("ignores derived data, notices identity changes", () => {
    expect(refsDigest(head, [{ ...a, ahead: 3 }, b])).toBe(refsDigest(head, [a, b]));
    expect(refsDigest(head, [{ ...a, commit: H3, target: H3 }, b])).not.toBe(refsDigest(head, [a, b]));
    expect(refsDigest({ kind: "detached", commit: H1 }, [a, b])).not.toBe(refsDigest(head, [a, b]));
    expect(refsDigest(head, [{ ...a, checkedOutAt: "/x" }, b])).not.toBe(refsDigest(head, [a, b]));
  });
  it("hash64 is stable", () => {
    expect(hash64("")).toBe(hash64(""));
    expect(hash64("a")).not.toBe(hash64("b"));
  });
});

describe("status v2 parser", () => {
  const out = [
    `# branch.oid ${H1}`,
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -3",
    `1 M. N... 100644 100644 100644 ${H1} ${H2} README.md`,
    `1 .M N... 100644 100644 100644 ${H1} ${H1} dir/file with space.txt`,
    `1 MD N... 100644 100644 000000 ${H1} ${H2} both.txt`,
    `2 R. N... 100644 100644 100644 ${H1} ${H1} R100 new name.ts`,
    "old name.ts",
    `u UU N... 100644 100644 100644 100644 ${H1} ${H2} ${H3} conflict.txt`,
    "? -dash.txt",
    "? ünïcødé.txt",
    "! ignored.log",
    "",
  ].join("\0");
  it("parses entries with spaces, renames, conflicts and branch info", () => {
    const s = parseStatusV2(out);
    expect(s.oid).toBe(H1);
    expect(s.branch).toEqual({ name: "main", upstream: "origin/main", ahead: 2, behind: 3 });
    expect(s.staged).toEqual([
      { path: "README.md", status: "M" },
      { path: "both.txt", status: "M" },
      { path: "new name.ts", oldPath: "old name.ts", status: "R" },
    ]);
    expect(s.unstaged).toEqual([
      { path: "dir/file with space.txt", status: "M" },
      { path: "both.txt", status: "D" },
    ]);
    expect(s.conflicted).toEqual([{ path: "conflict.txt", status: "U" }]);
    expect(s.untracked).toEqual(["-dash.txt", "ünïcødé.txt"]);
    expect(s.ignored).toEqual(["ignored.log"]);
  });
  it("handles detached and initial", () => {
    const s = parseStatusV2("# branch.oid (initial)\0# branch.head (detached)\0");
    expect(s.oid).toBeNull();
    expect(s.head).toBeNull();
    expect(s.branch).toBeUndefined();
  });
});

describe("raw + numstat parser", () => {
  it("pairs raw records with numstat, handling renames and binaries", () => {
    const z = [
      `:100644 100644 ${H1} ${H2} R087`,
      "src/old.ts",
      "src/new name.ts",
      `:100644 100644 ${H1} ${H2} M`,
      "logo.bin",
      `:000000 100644 ${"0".repeat(40)} ${H2} A`,
      "-dash.txt",
      "3\t1\t",
      "src/old.ts",
      "src/new name.ts",
      "-\t-\tlogo.bin",
      "1\t0\t-dash.txt",
      "",
    ].join("\0");
    expect(parseRawNumstat(z)).toEqual([
      { path: "src/new name.ts", oldPath: "src/old.ts", status: "R", additions: 3, deletions: 1 },
      { path: "logo.bin", status: "M", binary: true },
      { path: "-dash.txt", status: "A", additions: 1, deletions: 0 },
    ]);
  });
  it("handles empty output", () => {
    expect(parseRawNumstat("")).toEqual([]);
  });
});

describe("unified patch parser", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@ export function x() {",
    " one",
    "-two",
    "+TWO",
    " three",
    "@@ -10,2 +10,3 @@",
    " ten",
    " eleven",
    "+twelve",
    "\\ No newline at end of file",
    "diff --git a/file with space.txt b/file with space.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/file with space.txt\t",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/old.md b/new.md",
    "similarity index 90%",
    "rename from old.md",
    "rename to new.md",
    "diff --git a/logo.bin b/logo.bin",
    "index 3333333..4444444 100644",
    "Binary files a/logo.bin and b/logo.bin differ",
    'diff --git "a/\\303\\274.txt" "b/\\303\\274.txt"',
    "deleted file mode 100644",
    '--- "a/\\303\\274.txt"',
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "",
  ].join("\n");

  it("parses hunks, line numbers, statuses and paths", () => {
    const files = parseUnifiedDiff(patch);
    expect(files.map((f) => [f.path, f.status, f.binary, f.oldPath])).toEqual([
      ["src/a.ts", "M", false, undefined],
      ["file with space.txt", "A", false, undefined],
      ["new.md", "R", false, "old.md"],
      ["logo.bin", "M", true, undefined],
      ["ü.txt", "D", false, undefined],
    ]);
    const a = files[0]!;
    expect(a.hunks).toHaveLength(2);
    expect(a.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
    expect(a.hunks[0]!.lines).toEqual([
      { kind: "context", text: "one", oldNo: 1, newNo: 1 },
      { kind: "del", text: "two", oldNo: 2 },
      { kind: "add", text: "TWO", newNo: 2 },
      { kind: "context", text: "three", oldNo: 3, newNo: 3 },
    ]);
    expect(a.hunks[1]!.lines.at(-1)).toEqual({ kind: "meta", text: "\\ No newline at end of file" });
    expect(a.hunks[1]!.lines[2]).toEqual({ kind: "add", text: "twelve", newNo: 12 });
    expect(files[1]!.hunks[0]!.lines).toEqual([{ kind: "add", text: "hello", newNo: 1 }]);
  });

  it("combines with the raw file list (raw paths win)", () => {
    const sections = parsePatch(patch);
    const diffs = combineDiff(
      [
        { path: "src/a.ts", status: "M" },
        { path: "file with space.txt", status: "A" },
        { path: "new.md", oldPath: "old.md", status: "R" },
        { path: "logo.bin", status: "M", binary: true },
        { path: "ü.txt", status: "D" },
      ],
      sections,
    );
    expect(diffs.map((d) => d.hunks.length)).toEqual([2, 1, 0, 0, 1]);
    expect(diffs[3]!.binary).toBe(true);
  });

  it("rebuilds an applicable single-hunk patch", () => {
    const [a] = parseUnifiedDiff(patch);
    const p = hunkPatch(a!, a!.hunks[0]!);
    expect(p).toBe("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@ export function x() {\n one\n-two\n+TWO\n three\n");
  });
});

describe("worktree list parser", () => {
  it("parses -z output", () => {
    const z = [
      "worktree /repo",
      `HEAD ${H1}`,
      "branch refs/heads/main",
      "",
      "worktree /repo wt",
      `HEAD ${H2}`,
      "detached",
      "locked reason with spaces",
      "",
      "worktree /gone",
      `HEAD ${H3}`,
      "branch refs/heads/x",
      "prunable gitdir file points to non-existent location",
      "",
      "",
    ].join("\0");
    const list = parseWorktreeList(z, "\0", "/repo wt");
    expect(list).toEqual([
      { path: "/repo", head: H1, branch: "refs/heads/main", bare: false, detached: false, locked: false, prunable: false, isMain: true, isCurrent: false },
      { path: "/repo wt", head: H2, bare: false, detached: true, locked: true, lockReason: "reason with spaces", prunable: false, isMain: false, isCurrent: true },
      {
        path: "/gone",
        head: H3,
        branch: "refs/heads/x",
        bare: false,
        detached: false,
        locked: false,
        prunable: true,
        prunableReason: "gitdir file points to non-existent location",
        isMain: false,
        isCurrent: false,
      },
    ]);
  });
  it("parses newline output (older git)", () => {
    const list = parseWorktreeList(`worktree /bare.git\nbare\n\nworktree /w\nHEAD ${H1}\nbranch refs/heads/a\nlocked\n`, "\n");
    expect(list[0]).toMatchObject({ path: "/bare.git", bare: true, isMain: true });
    expect(list[1]).toMatchObject({ path: "/w", locked: true, branch: "refs/heads/a" });
    expect(list[1]!.lockReason).toBeUndefined();
  });
});

describe("blame porcelain parser", () => {
  it("reuses commit metadata for repeated hashes", () => {
    const out = [
      `${H1} 1 1 2`,
      "author Ada",
      "author-mail <ada@example.com>",
      "author-time 1700000000",
      "summary First",
      "filename a.txt",
      "\tline one",
      `${H1} 2 2`,
      "\tline two",
      `${H2} 5 3 1`,
      "author Grace",
      "author-time 1700000500",
      "filename a.txt",
      "\t\tindented",
      "",
    ].join("\n");
    expect(parseBlamePorcelain(out)).toEqual([
      { line: 1, hash: H1, author: "Ada", date: 1700000000, text: "line one" },
      { line: 2, hash: H1, author: "Ada", date: 1700000000, text: "line two" },
      { line: 3, hash: H2, author: "Grace", date: 1700000500, text: "\tindented" },
    ]);
  });
});

describe("text helpers", () => {
  it("unquotes C-style paths", () => {
    expect(unquoteCPath('"\\303\\274n\\303\\257.txt"')).toBe("ünï.txt");
    expect(unquoteCPath('"a\\tb\\"c\\\\"')).toBe('a\tb"c\\');
    expect(unquoteCPath("plain name")).toBe("plain name");
  });
  it("scrubs credentials", () => {
    expect(scrubUrl("https://user:ghp_secret@github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(scrubUrl("ssh://git:pw@host/x")).toBe("ssh://git@host/x");
    expect(scrubUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    expect(scrubText("fatal: unable to access 'https://x:tok@github.com/o/r/'")).toBe("fatal: unable to access 'https://***@github.com/o/r/'");
  });
});
