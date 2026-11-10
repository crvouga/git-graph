// The worker RPC (serveRepository / connectRepository) over a Node MessageChannel.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError, DEFAULT_HISTORY_QUERY } from "../../src/core/types.ts";
import { BrowserGitRepository } from "../../src/browser-git/repo.ts";
import { connectRepository, serveRepository, type Endpoint } from "../../src/browser-git/rpc.ts";
import { makeBasic } from "../fixtures/make-fixtures.ts";
import { NodeDirSource } from "./browser-git-node-source.ts";

let tmp: string;
let repoDir: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "lanes-browser-git-rpc-"));
  repoDir = makeBasic(tmp).repo;
}, 120_000);
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function pair(dir: unknown) {
  const { port1, port2 } = new MessageChannel();
  let opened: BrowserGitRepository | null = null;
  serveRepository(port2 as unknown as Endpoint, async (msg) => {
    opened = await BrowserGitRepository.open(new NodeDirSource(msg.handle as string), msg.repoId, { name: msg.name });
    return opened;
  });
  const client = connectRepository(port1 as unknown as Endpoint, { provider: "browser", id: "rpc" }, { handle: dir, name: "basic" }, () => {
    port1.close();
    port2.close();
  });
  return { client, opened: () => opened };
}

describe("worker RPC", () => {
  it("proxies reads and keeps transfers page-sized", async () => {
    const { client } = pair(repoDir);
    await client.ready();
    expect(client.key).toBe("browser:rpc");
    const info = await client.info();
    expect(info).toMatchObject({ name: "basic", key: "browser:rpc" });
    const page = await client.history(DEFAULT_HISTORY_QUERY, null, 5, {});
    expect(page.commits).toHaveLength(5);
    const next = await client.history(DEFAULT_HISTORY_QUERY, page.cursor, 5);
    expect(next.commits[0]!.hash).not.toBe(page.commits[0]!.hash);
    const details = await client.commit(page.commits[0]!.hash);
    expect(details.hash).toBe(page.commits[0]!.hash);
    const diff = await client.diff({ kind: "commit", hash: page.commits[0]!.hash });
    expect(Array.isArray(diff.files)).toBe(true);
    client.dispose();
  });

  it("serializes errors as AppError", async () => {
    const { client } = pair(repoDir);
    const err = await client.mutate({ op: "fetch" }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("UNSUPPORTED");
    const err2 = await client.commit("nope").catch((e) => e);
    expect(err2.code).toBe("REF_NOT_FOUND");
    client.dispose();
  });

  it("surfaces open failures from ready()", async () => {
    const { client } = pair(join(tmp, "missing-dir"));
    await expect(client.ready()).rejects.toMatchObject({ code: "NOT_FOUND" });
    client.dispose();
  });

  it("cancels through AbortSignal", async () => {
    const { client } = pair(repoDir);
    await client.ready();
    const ctrl = new AbortController();
    const p = client.history(DEFAULT_HISTORY_QUERY, null, 10, { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    const pre = new AbortController();
    pre.abort();
    await expect(client.refs({ signal: pre.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    // Still usable afterwards.
    expect((await client.refs()).refs.length).toBeGreaterThan(5);
    client.dispose();
  });
});
