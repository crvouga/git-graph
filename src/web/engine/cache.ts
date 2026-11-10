// IndexedDB repository cache (runs in the engine worker).
//   history: per (repo, query) the first N rows + refs snapshot  → instant stale render, offline browsing
//   objects: immutable data keyed by object id (commit details, commit diffs) → never revalidated
//   meta:    repo info + capabilities
// Bounded: LRU eviction by `usedAt` on history entries and object count.

import type { Commit, RefsSnapshot } from "../../core/types.ts";

const DB = "lanes-cache";
const VERSION = 1;
const MAX_HISTORY_ENTRIES = 24;
const MAX_HISTORY_ROWS = 5000;
const MAX_OBJECTS = 4000;

export interface HistoryEntry {
  key: string;
  repoKey: string;
  refs: RefsSnapshot;
  commits: Commit[];
  complete: boolean;
  savedAt: number;
  usedAt: number;
}

let dbp: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("history")) db.createObjectStore("history", { keyPath: "key" }).createIndex("usedAt", "usedAt");
        if (!db.objectStoreNames.contains("objects")) db.createObjectStore("objects", { keyPath: "key" }).createIndex("usedAt", "usedAt");
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore | null> {
  const db = await open();
  if (!db) return null;
  try {
    return db.transaction(name, mode).objectStore(name);
  } catch {
    return null;
  }
}

export const stats = { hits: 0, misses: 0 };

export async function getHistory(key: string): Promise<HistoryEntry | null> {
  try {
    const s = await store("history", "readwrite");
    if (!s) return null;
    const e = (await wrap(s.get(key))) as HistoryEntry | undefined;
    if (!e) {
      stats.misses++;
      return null;
    }
    stats.hits++;
    e.usedAt = Date.now();
    s.put(e);
    return e;
  } catch {
    return null;
  }
}

export async function putHistory(e: Omit<HistoryEntry, "savedAt" | "usedAt">): Promise<void> {
  try {
    const s = await store("history", "readwrite");
    if (!s) return;
    const now = Date.now();
    s.put({ ...e, commits: e.commits.slice(0, MAX_HISTORY_ROWS), complete: e.complete && e.commits.length <= MAX_HISTORY_ROWS, savedAt: now, usedAt: now });
    const count = await wrap(s.count());
    if (count > MAX_HISTORY_ENTRIES) await evict("history", count - MAX_HISTORY_ENTRIES);
  } catch {
    /* cache is best-effort */
  }
}

export async function getObject<T>(key: string): Promise<T | null> {
  try {
    const s = await store("objects", "readonly");
    if (!s) return null;
    const e = (await wrap(s.get(key))) as { value: T } | undefined;
    if (e) stats.hits++;
    else stats.misses++;
    return e ? e.value : null;
  } catch {
    return null;
  }
}

let objectWrites = 0;
export async function putObject(key: string, value: unknown): Promise<void> {
  try {
    const s = await store("objects", "readwrite");
    if (!s) return;
    s.put({ key, value, usedAt: Date.now() });
    if (++objectWrites % 100 === 0) {
      const count = await wrap(s.count());
      if (count > MAX_OBJECTS) await evict("objects", count - MAX_OBJECTS);
    }
  } catch {
    /* best-effort */
  }
}

async function evict(name: string, n: number) {
  const s = await store(name, "readwrite");
  if (!s) return;
  const idx = s.index("usedAt");
  let left = n;
  await new Promise<void>((res) => {
    const cur = idx.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || left <= 0) return res();
      c.delete();
      left--;
      c.continue();
    };
    cur.onerror = () => res();
  });
}

export async function getMeta<T>(key: string): Promise<T | null> {
  try {
    const s = await store("meta", "readonly");
    if (!s) return null;
    const e = (await wrap(s.get(key))) as { value: T } | undefined;
    return e ? e.value : null;
  } catch {
    return null;
  }
}

export async function putMeta(key: string, value: unknown): Promise<void> {
  try {
    const s = await store("meta", "readwrite");
    s?.put({ key, value });
  } catch {
    /* best-effort */
  }
}
