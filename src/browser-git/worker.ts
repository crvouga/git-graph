// Dedicated Web Worker hosting one BrowserGitRepository. Created by client.ts.

import { BrowserGitRepository } from "./repo.ts";
import { serveRepository, type Endpoint } from "./rpc.ts";
import { FsAccessSource } from "./source.ts";

serveRepository(self as unknown as Endpoint, (msg) =>
  BrowserGitRepository.open(new FsAccessSource(msg.handle as FileSystemDirectoryHandle), msg.repoId, msg.name ? { name: msg.name } : {}),
);
