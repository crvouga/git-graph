// Persist File System Access directory handles (structured-cloneable) in IndexedDB so a folder
// opened in the browser can be reopened from a URL (/browser/<id>) after a reload.

const DB = "lanes-handles";

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("handles");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function saveHandle(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const d = await db();
  await new Promise<void>((res, rej) => {
    const tx = d.transaction("handles", "readwrite");
    tx.objectStore("handles").put(handle, id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function loadHandle(id: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    const d = await db();
    return await new Promise((res) => {
      const r = d.transaction("handles").objectStore("handles").get(id);
      r.onsuccess = () => res((r.result as FileSystemDirectoryHandle) ?? null);
      r.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}

/** Stable id for a picked folder: random, remembered alongside the handle. */
export function newHandleId(): string {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const fsAccessSupported = typeof window !== "undefined" && "showDirectoryPicker" in window;
