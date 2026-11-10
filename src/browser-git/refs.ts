// Reads HEAD, loose refs, packed-refs, the stash reflog and linked-worktree HEADs into a RefsSnapshot.

import type { HeadState, Ref, RefsSnapshot } from "../core/types.ts";
import { digest, isFullHash } from "./hex.ts";
import type { GitLayout } from "./layout.ts";
import type { ObjectDatabase } from "./objects.ts";
import { parseTag } from "./parse.ts";
import { joinPath, type DirSource } from "./source.ts";

interface RawRef {
  /** Object hash, or undefined for a symbolic ref. */
  hash?: string;
  symref?: string;
  peeled?: string;
}

const p = (base: string, rel: string) => joinPath(base, rel)!;

export async function readPackedRefs(src: DirSource, commonDir: string): Promise<Map<string, RawRef>> {
  const out = new Map<string, RawRef>();
  const text = await src.readText(p(commonDir, "packed-refs"));
  if (!text) return out;
  let last: RawRef | null = null;
  for (const line of text.split("\n")) {
    if (!line || line[0] === "#") continue;
    if (line[0] === "^") {
      if (last) last.peeled = line.slice(1, 41);
      continue;
    }
    const sp = line.indexOf(" ");
    const hash = line.slice(0, sp);
    if (!isFullHash(hash)) {
      last = null;
      continue;
    }
    last = { hash };
    out.set(line.slice(sp + 1).trim(), last);
  }
  return out;
}

async function readLooseRefs(src: DirSource, commonDir: string, dir: string, out: Map<string, RawRef>): Promise<void> {
  const entries = await src.list(p(commonDir, dir));
  if (!entries) return;
  await Promise.all(
    entries.map(async (e) => {
      const name = `${dir}/${e.name}`;
      if (e.kind === "directory") return readLooseRefs(src, commonDir, name, out);
      if (e.name.endsWith(".lock")) return;
      const text = (await src.readText(p(commonDir, name)))?.trim();
      if (!text) return;
      if (text.startsWith("ref:")) out.set(name, { symref: text.slice(4).trim() });
      else if (isFullHash(text)) out.set(name, { hash: text });
    }),
  );
}

function parseHeadFile(text: string | null): RawRef | null {
  const t = text?.trim();
  if (!t) return null;
  if (t.startsWith("ref:")) return { symref: t.slice(4).trim() };
  return isFullHash(t) ? { hash: t } : null;
}

export interface RefsResult {
  snapshot: RefsSnapshot;
  /** Every ref name (full) → object hash, including other namespaces. */
  all: Map<string, string>;
}

export async function readRefs(src: DirSource, layout: GitLayout, odb: ObjectDatabase): Promise<RefsResult> {
  const { commonDir, gitDir, config } = layout;
  const [packed, headText, stashLog] = await Promise.all([
    readPackedRefs(src, commonDir),
    src.readText(p(gitDir, "HEAD")),
    src.readText(p(commonDir, "logs/refs/stash")),
  ]);
  const loose = new Map<string, RawRef>();
  await readLooseRefs(src, commonDir, "refs", loose);
  const raw = new Map(packed);
  for (const [k, v] of loose) raw.set(k, v); // loose wins

  const resolve = (name: string): string | undefined => {
    for (let i = 0; i < 10; i++) {
      const r = raw.get(name);
      if (!r) return undefined;
      if (r.hash) return r.hash;
      name = r.symref!;
    }
    return undefined;
  };

  const all = new Map<string, string>();
  for (const k of raw.keys()) {
    const h = resolve(k);
    if (h) all.set(k, h);
  }

  // HEAD
  let head: HeadState = { kind: "none" };
  const headRaw = parseHeadFile(headText);
  if (headRaw?.hash) head = { kind: "detached", commit: headRaw.hash };
  else if (headRaw?.symref) {
    const h = resolve(headRaw.symref);
    head = h ? { kind: "branch", ref: headRaw.symref, commit: h } : { kind: "unborn", ref: headRaw.symref };
  }

  // Linked worktrees: which branch is checked out where.
  const checkedOut = new Map<string, string>();
  const wtEntries = (await src.list(p(commonDir, "worktrees"))) ?? [];
  await Promise.all(
    wtEntries
      .filter((e) => e.kind === "directory")
      .map(async (e) => {
        const [h, gd] = await Promise.all([src.readText(p(commonDir, `worktrees/${e.name}/HEAD`)), src.readText(p(commonDir, `worktrees/${e.name}/gitdir`))]);
        const r = parseHeadFile(h);
        if (r?.symref && gd) checkedOut.set(r.symref, gd.trim().replace(/\/\.git\/?$/, ""));
      }),
  );

  const remoteNames = config.subsections("remote").sort((a, b) => b.length - a.length);
  const names = [...raw.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Peel tags in parallel (annotated tags, chains included) and pick up the message.
  const peeled = new Map<string, { commit: string; message?: string } | null>();
  await Promise.all(
    names
      .filter((n) => n.startsWith("refs/tags/"))
      .map(async (name) => {
        const target = resolve(name);
        if (!target) return;
        const r = raw.get(name)!;
        let cur = target;
        let message: string | undefined;
        for (let i = 0; i < 20; i++) {
          const o = await odb.read(cur);
          if (!o) {
            if (!r.peeled) return peeled.set(name, null);
            cur = r.peeled;
            break;
          }
          if (o.type === "commit") break;
          if (o.type !== "tag") return peeled.set(name, null); // tags of trees/blobs are not shown
          const t = parseTag(o.data);
          if (cur === target && t.message.trim()) message = t.message.trim();
          cur = t.object;
        }
        peeled.set(name, { commit: cur, ...(message ? { message } : {}) });
      }),
  );

  const refs: Ref[] = [];
  for (const name of names) {
    const r = raw.get(name)!;
    const target = resolve(name);
    if (!target) continue;
    if (name.startsWith("refs/heads/")) {
      const short = name.slice(11);
      const ref: Ref = { name, kind: "head", short, target, commit: target };
      const remote = config.get(`branch.${short}.remote`);
      const merge = config.get(`branch.${short}.merge`);
      if (remote && merge) {
        const up = remote === "." ? merge : `refs/remotes/${remote}/${merge.replace(/^refs\/heads\//, "")}`;
        if (all.has(up)) ref.upstream = up;
      }
      const wt = checkedOut.get(name);
      if (wt) ref.checkedOutAt = wt;
      refs.push(ref);
    } else if (name.startsWith("refs/remotes/")) {
      const short = name.slice(13);
      const remote = remoteNames.find((n) => short.startsWith(n + "/")) ?? short.split("/")[0]!;
      const ref: Ref = { name, kind: "remote", short, target, commit: target, remote };
      if (r.symref) ref.symbolicTarget = r.symref;
      refs.push(ref);
    } else if (name.startsWith("refs/tags/")) {
      const p = peeled.get(name);
      if (!p) continue;
      refs.push({ name, kind: "tag", short: name.slice(10), target, commit: p.commit, ...(p.message ? { message: p.message } : {}) });
    }
  }

  // Stashes: stash@{0} is the newest reflog line.
  const stashTip = all.get("refs/stash");
  if (stashTip) {
    const entries = (stashLog ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const parts = line.split(" ");
        return { hash: parts[1]!, message: tab >= 0 ? line.slice(tab + 1) : "" };
      })
      .filter((e) => isFullHash(e.hash))
      .reverse();
    if (!entries.length || entries[0]!.hash !== stashTip) entries.unshift({ hash: stashTip, message: "" });
    entries.forEach((e, i) => {
      refs.push({ name: `refs/stash@{${i}}`, kind: "stash", short: `stash@{${i}}`, target: e.hash, commit: e.hash, ...(e.message ? { message: e.message } : {}) });
    });
  }

  const version = digest(
    JSON.stringify([head, refs.map((r) => [r.name, r.target, r.commit, r.symbolicTarget ?? "", r.upstream ?? "", r.checkedOutAt ?? "", r.message ?? ""])]),
  );
  return { snapshot: { head, refs, version }, all };
}
