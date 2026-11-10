// Parsers for commit, tree and tag objects.

import type { Person } from "../core/types.ts";
import { toHex } from "./hex.ts";

const utf8 = new TextDecoder();
const decoders = new Map<string, TextDecoder>();

function decodeWith(enc: string | undefined, bytes: Uint8Array): string {
  if (!enc || /^utf-?8$/i.test(enc)) return utf8.decode(bytes);
  let d = decoders.get(enc);
  if (!d) {
    try {
      d = new TextDecoder(enc);
    } catch {
      d = utf8;
    }
    decoders.set(enc, d);
  }
  return d.decode(bytes);
}

export interface PersonTz extends Person {
  /** Timezone offset as written by git, e.g. "+0200". */
  tz: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: PersonTz;
  committer: PersonTz;
  /** Raw message (after the blank line that ends the headers). */
  message: string;
  signed: boolean;
}

export function parsePerson(s: string): PersonTz {
  const lt = s.indexOf("<");
  const gt = s.lastIndexOf(">");
  if (lt < 0 || gt < lt) return { name: s.trim(), email: "", date: 0, tz: "+0000" };
  const rest = s.slice(gt + 1).trim().split(/\s+/);
  const date = Number(rest[0]);
  return {
    name: s.slice(0, lt).trim(),
    email: s.slice(lt + 1, gt),
    date: Number.isFinite(date) ? date : 0,
    tz: rest[1] ?? "+0000",
  };
}

export function parseCommit(data: Uint8Array): ParsedCommit {
  // Headers are ASCII-ish; find the header/message boundary first so non-UTF-8 messages decode correctly.
  let end = -1;
  for (let i = 0; i + 1 < data.length; i++) {
    if (data[i] === 10 && data[i + 1] === 10) {
      end = i;
      break;
    }
  }
  const headerBytes = end < 0 ? data : data.subarray(0, end);
  const headers = utf8.decode(headerBytes);
  let tree = "";
  const parents: string[] = [];
  let author = "";
  let committer = "";
  let encoding: string | undefined;
  let signed = false;
  let pos = 0;
  while (pos < headers.length) {
    let nl = headers.indexOf("\n", pos);
    if (nl < 0) nl = headers.length;
    const line = headers.slice(pos, nl);
    pos = nl + 1;
    if (line.charCodeAt(0) === 32) continue; // continuation of a multi-line header (gpgsig, mergetag)
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? "" : line.slice(sp + 1);
    switch (key) {
      case "tree":
        tree = val;
        break;
      case "parent":
        parents.push(val);
        break;
      case "author":
        author = val;
        break;
      case "committer":
        committer = val;
        break;
      case "encoding":
        encoding = val;
        break;
      case "gpgsig":
      case "gpgsig-sha256":
        signed = true;
        break;
    }
  }
  const message = end < 0 ? "" : decodeWith(encoding, data.subarray(end + 2));
  return { tree, parents, author: parsePerson(author), committer: parsePerson(committer), message, signed };
}

/** Git's %s / %b split: subject = first paragraph joined by spaces, body = the rest. */
export function splitMessage(message: string): { subject: string; body: string } {
  const lines = message.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  const subj: string[] = [];
  while (i < lines.length && lines[i]!.trim()) subj.push(lines[i++]!.trim());
  while (i < lines.length && !lines[i]!.trim()) i++;
  const body = lines.slice(i).join("\n").replace(/\s+$/, "");
  return { subject: subj.join(" "), body };
}

/** Subject only, without building the body (hot path for the history walk). */
export function subjectOf(message: string): string {
  let out = "";
  let started = false;
  let pos = 0;
  while (pos <= message.length) {
    let nl = message.indexOf("\n", pos);
    if (nl < 0) nl = message.length;
    const t = message.slice(pos, nl).trim();
    pos = nl + 1;
    if (!t) {
      if (started) break;
      continue;
    }
    out = started ? out + " " + t : t;
    started = true;
  }
  return out;
}

export interface TreeEntry {
  mode: string;
  name: string;
  hash: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    let sp = i;
    while (data[sp] !== 32) sp++;
    let nul = sp + 1;
    while (data[nul] !== 0) nul++;
    let mode = "";
    for (let k = i; k < sp; k++) mode += String.fromCharCode(data[k]!);
    if (mode.length === 5) mode = "0" + mode; // "40000" → "040000"
    out.push({ mode, name: utf8.decode(data.subarray(sp + 1, nul)), hash: toHex(data, nul + 1, 20) });
    i = nul + 21;
  }
  return out;
}

export const isTreeMode = (m: string): boolean => m === "040000";
export const isSubmoduleMode = (m: string): boolean => m === "160000";

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger?: PersonTz;
  message: string;
}

export function parseTag(data: Uint8Array): ParsedTag {
  const text = utf8.decode(data);
  const end = text.indexOf("\n\n");
  const head = end < 0 ? text : text.slice(0, end);
  const out: ParsedTag = { object: "", type: "", tag: "", message: end < 0 ? "" : text.slice(end + 2) };
  for (const line of head.split("\n")) {
    const sp = line.indexOf(" ");
    const k = line.slice(0, sp);
    const v = line.slice(sp + 1);
    if (k === "object") out.object = v;
    else if (k === "type") out.type = v;
    else if (k === "tag") out.tag = v;
    else if (k === "tagger") out.tagger = parsePerson(v);
  }
  // Strip an inline PGP signature from the message.
  const sig = out.message.indexOf("-----BEGIN PGP SIGNATURE-----");
  if (sig >= 0) out.message = out.message.slice(0, sig);
  return out;
}
