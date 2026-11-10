// Main-thread entry point: open a folder picked with the File System Access API as a read-only
// RepositoryPort whose work runs in a dedicated Web Worker.
//
//   const handle = await showDirectoryPicker();
//   const repo = openBrowserRepository(handle, "my-repo");
//   await repo.ready(); // surfaces "not a repository" / UNSUPPORTED layout errors
//
// The adapter has no change notifications: subscribe() is a no-op, poll refs() and reload history
// when RefsSnapshot.version changes.

import { connectRepository, type BrowserRepositoryClient } from "./rpc.ts";

export type { BrowserRepositoryClient } from "./rpc.ts";
export { READ_ONLY_REASON } from "./layout.ts";

/** `id` must match /^[A-Za-z0-9_-]{1,64}$/ (it becomes the repo key "browser:<id>"). */
export function openBrowserRepository(handle: FileSystemDirectoryHandle, id: string): BrowserRepositoryClient {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: `lanes-git-${id}` });
  return connectRepository(worker, { provider: "browser", id }, { handle, name: handle.name }, () => worker.terminate());
}
