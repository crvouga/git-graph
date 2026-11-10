// Parsers for `git for-each-ref` and stash reflog output, plus the refs version digest.

import type { HeadState, Ref, RefKind } from "../types.ts";

/** Fields: refname, objectname, *objectname, upstream, upstream:track, worktreepath, symref, objecttype. */
export const FOR_EACH_REF_FORMAT = "%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(upstream:track)%00%(worktreepath)%00%(symref)%00%(objecttype)";
/** Same without the (expensive) ahead/behind computation; used for cheap change detection. */
export const FOR_EACH_REF_FORMAT_CHEAP = "%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%00%(worktreepath)%00%(symref)%00%(objecttype)";

export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } | null {
  if (!track) return null;
  if (track.includes("gone")) return { ahead: 0, behind: 0, gone: true };
  const a = /ahead (\d+)/.exec(track);
  const b = /behind (\d+)/.exec(track);
  return { ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0, gone: false };
}

function kindOf(name: string): { kind: RefKind; short: string; remote?: string } | null {
  if (name.startsWith("refs/heads/")) return { kind: "head", short: name.slice(11) };
  if (name.startsWith("refs/tags/")) return { kind: "tag", short: name.slice(10) };
  if (name.startsWith("refs/remotes/")) {
    const short = name.slice(13);
    const slash = short.indexOf("/");
    return { kind: "remote", short, remote: slash > 0 ? short.slice(0, slash) : short };
  }
  return null;
}

/**
 * Parse newline-separated records of FOR_EACH_REF_FORMAT. `refs/stash` is skipped (stashes come
 * from the reflog, see parseStashList). Other non-standard namespaces (refs/notes, refs/pull) are skipped.
 */
export function parseForEachRef(out: string, opts: { remoteNames?: readonly string[]; withTrack?: boolean } = {}): Ref[] {
  const remoteNames = opts.remoteNames;
  const refs: Ref[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const f = line.split("\0");
    const name = f[0]!;
    const k = kindOf(name);
    if (!k) continue;
    const target = f[1]!;
    const peeled = f[2] || "";
    const ref: Ref = { name, kind: k.kind, short: k.short, target, commit: peeled || target };
    if (k.kind === "remote") {
      // Remote names may contain "/": prefer the longest configured remote that prefixes the ref.
      const match = remoteNames?.filter((r) => k.short.startsWith(`${r}/`) || k.short === r).sort((a, b) => b.length - a.length)[0];
      ref.remote = match ?? k.remote;
    }
    if (f[3]) ref.upstream = f[3];
    if (f[3] && opts.withTrack) {
      // Empty track with an upstream means "in sync"; "[gone]" means the upstream ref vanished.
      const t = parseTrack(f[4] ?? "") ?? { ahead: 0, behind: 0, gone: false };
      if (!t.gone) {
        ref.ahead = t.ahead;
        ref.behind = t.behind;
      }
    }
    if (f[5]) ref.checkedOutAt = f[5];
    if (f[6]) ref.symbolicTarget = f[6];
    refs.push(ref);
  }
  return refs;
}

/** Format for `git log -g -z refs/stash`: hash, reflog selector, subject. */
export const STASH_LIST_FORMAT = "%H%x00%gd%x00%gs";

/** Parse `git log -g -z --format=STASH_LIST_FORMAT refs/stash`. */
export function parseStashList(out: string): Ref[] {
  const tok = out.split("\0");
  const refs: Ref[] = [];
  for (let i = 0; i + 2 < tok.length; i += 3) {
    const hash = tok[i]!.replace(/^\n/, "");
    if (!hash) continue;
    const sel = tok[i + 1]!; // "refs/stash@{0}" or "stash@{0}"
    const m = /\{(\d+)\}/.exec(sel);
    const n = m ? Number(m[1]) : refs.length;
    refs.push({ name: `refs/stash@{${n}}`, kind: "stash", short: `stash@{${n}}`, target: hash, commit: hash, message: tok[i + 2]! });
  }
  return refs;
}

export function headFrom(symref: string | null, commit: string | null): HeadState {
  if (symref) return commit ? { kind: "branch", ref: symref, commit } : { kind: "unborn", ref: symref };
  if (commit) return { kind: "detached", commit };
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/** 64-bit hash (two independent 32-bit FNV-1a lanes) as 16 hex chars. Deterministic, browser-safe. */
export function hash64(s: string): string {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x050c5d1f | 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 15);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
  h2 = Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35);
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/**
 * Digest of HEAD + refs. Only identity fields participate (name, target, peeled commit, upstream
 * config, worktree checkout, symref) — derived data such as ahead/behind or messages does not, so
 * a cheap for-each-ref without tracking info yields the same version as the full snapshot.
 */
export function refsDigest(head: HeadState, refs: readonly Ref[]): string {
  const h =
    head.kind === "branch" ? `B ${head.ref} ${head.commit}` : head.kind === "detached" ? `D ${head.commit}` : head.kind === "unborn" ? `U ${head.ref}` : "N";
  const lines = refs.map((r) => `${r.name}\t${r.target}\t${r.commit}\t${r.upstream ?? ""}\t${r.checkedOutAt ?? ""}\t${r.symbolicTarget ?? ""}`);
  lines.sort();
  return hash64(`${h}\n${lines.join("\n")}`);
}
