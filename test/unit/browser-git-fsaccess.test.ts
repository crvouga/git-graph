// FsAccessSource against a fake FileSystemDirectoryHandle backed by the real disk.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_HISTORY_QUERY } from "../../src/core/types.ts";
import { BrowserGitRepository } from "../../src/browser-git/repo.ts";
import { FsAccessSource } from "../../src/browser-git/source.ts";
import { fixtureEnv, makeBasic, makePacked } from "../fixtures/make-fixtures.ts";

const notFound = () => new DOMException("not found", "NotFoundError");
const typeMismatch = () => new DOMException("type mismatch", "TypeMismatchError");

function fakeDir(path: string): unknown {
  return {
    kind: "directory",
    name: basename(path),
    async getDirectoryHandle(name: string) {
      const p = join(path, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        throw notFound();
      }
      if (!st.isDirectory()) throw typeMismatch();
      return fakeDir(p);
    },
    async getFileHandle(name: string) {
      const p = join(path, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        throw notFound();
      }
      if (!st.isFile()) throw typeMismatch();
      return { kind: "file", name, getFile: async () => new File([readFileSync(p)], name, { lastModified: st.mtimeMs }) };
    },
    async *values() {
      for (const e of readdirSync(path, { withFileTypes: true })) {
        if (e.isFile() || e.isDirectory()) yield { kind: e.isDirectory() ? "directory" : "file", name: e.name };
      }
    },
  };
}

let tmp: string;
let basic: string;
let packed: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "lanes-browser-git-fsa-"));
  basic = makeBasic(tmp).repo;
  packed = makePacked(tmp);
}, 120_000);
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("FsAccessSource", () => {
  it.each([
    ["loose", () => basic],
    ["packed", () => packed],
  ])("reads a %s repository through directory handles", async (_k, dir) => {
    for (const wholePackLimit of [undefined, 0]) {
      const src = new FsAccessSource(fakeDir(dir()) as FileSystemDirectoryHandle);
      expect(await src.readFile("nope/nothing")).toBeNull();
      expect(await src.list("nope")).toBeNull();
      expect(await src.readFile(".git/refs")).toBeNull(); // a directory, not a file
      const repo = await BrowserGitRepository.open(src, "fsa", wholePackLimit === undefined ? {} : { wholePackLimit });
      const all: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await repo.history(DEFAULT_HISTORY_QUERY, cursor, 4);
        all.push(...page.commits.map((c) => c.hash));
        cursor = page.cursor;
      } while (cursor);
      const expected = execFileSync("git", ["log", "--date-order", "--all", "--format=%H"], { cwd: dir(), env: fixtureEnv(), encoding: "utf8" }).trim().split("\n");
      expect(all).toEqual(expected);
      const d = await repo.diff({ kind: "commit", hash: expected[3]! });
      expect(d.files.length).toBeGreaterThanOrEqual(0);
    }
  });
});
