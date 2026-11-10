// OpenAPI 3.1 document generated from the command registry, so documentation never drifts.

import { ERROR_CODES } from "../types.ts";
import { describeCommand, type CommandRegistry } from "../commands/registry.ts";

const repoParam = { name: "id", in: "path", required: true, schema: { type: "string" }, description: 'Repository key, e.g. "github:owner:repo" or "local:<id>"' };
const errorSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: { code: { type: "string", enum: [...ERROR_CODES] }, message: { type: "string" }, details: { type: "object" } },
    },
  },
};

function q(name: string, description: string, type = "string") {
  return { name, in: "query", required: false, schema: { type }, description };
}

const readRoutes: [string, string, string, unknown[]][] = [
  ["/repositories", "repo.list", "List repositories", [q("query", "Filter"), q("limit", "Max results", "integer")]],
  ["/repositories/{id}", "repo.info", "Repository info", [repoParam]],
  ["/repositories/{id}/capabilities", "repo.capabilities", "Capabilities with unavailable reasons", [repoParam]],
  ["/repositories/{id}/refs", "repo.refs", "Refs snapshot (ETag = version; send If-None-Match for 304)", [repoParam]],
  [
    "/repositories/{id}/commits",
    "repo.history",
    "Page of commits in graph order",
    [repoParam, q("ref", "Ref to include (repeatable)"), q("remotes", "Include remote branches (0/1)"), q("tags", "0/1"), q("stashes", "0/1"), q("order", "date|topo|author-date"), q("first-parent", "0/1"), q("cursor", "Cursor from the previous page"), q("limit", "Page size", "integer")],
  ],
  ["/repositories/{id}/commits/{hash}", "repo.commit", "Commit details (immutable for full hashes)", [repoParam, { name: "hash", in: "path", required: true, schema: { type: "string" } }]],
  ["/repositories/{id}/compare", "repo.compare", "Compare two commits", [repoParam, q("base", "Base commit"), q("head", "Head commit"), q("path", "Limit to a path")]],
  ["/repositories/{id}/diff", "repo.diff", "Structured diff", [repoParam, q("hash", "Commit"), q("base", "Base"), q("head", "Head"), q("working", "staged|unstaged"), q("path", "Path"), q("context", "Context lines", "integer")]],
  ["/repositories/{id}/search", "repo.search", "Search commits", [repoParam, q("text", "Search text"), q("limit", "Max results", "integer")]],
  ["/repositories/{id}/file-history", "repo.fileHistory", "File history", [repoParam, q("path", "File path"), q("cursor", "Cursor")]],
  ["/repositories/{id}/blame", "repo.blame", "Blame", [repoParam, q("path", "File path"), q("rev", "Revision")]],
  ["/repositories/{id}/file", "repo.file", "File contents at a revision", [repoParam, q("path", "File path"), q("rev", "Revision")]],
  ["/repositories/{id}/status", "repo.status", "Working tree status (local)", [repoParam]],
  ["/repositories/{id}/worktrees", "repo.worktrees", "Worktrees (local)", [repoParam]],
  ["/repositories/{id}/remotes", "repo.remotes", "Remotes (local)", [repoParam]],
  ["/repositories/{id}/conflict", "repo.conflict", "Conflict stages (local)", [repoParam, q("path", "File path")]],
];

export function openApiDocument(registry: CommandRegistry) {
  const paths: Record<string, unknown> = {};
  const responses = (desc: string) => ({
    "200": { description: desc, content: { "application/json": { schema: { type: "object" } } } },
    default: { description: "Error", content: { "application/json": { schema: errorSchema } } },
  });
  for (const [path, cmd, summary, parameters] of readRoutes) {
    paths[path] = { get: { operationId: cmd, summary, parameters, responses: responses(summary), "x-command": cmd } };
  }
  paths["/repositories/{id}/events"] = {
    get: {
      operationId: "repo.events",
      summary: "Server-Sent Events stream of RepositoryEvent envelopes. Resume with Last-Event-ID or ?cursor=<epoch>:<seq>. A `resync` event means: re-read refs.",
      parameters: [repoParam, q("cursor", "Resume cursor")],
      responses: { "200": { description: "text/event-stream", content: { "text/event-stream": {} } } },
    },
  };
  paths["/repositories/{id}/mutations"] = {
    post: {
      operationId: "repo.mutate",
      summary: "Perform a Git mutation. Destructive ones first return 428 CONFIRMATION_REQUIRED with details.confirmToken; resend with confirm=<token>.",
      parameters: [repoParam],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["mutation"],
              properties: { mutation: { type: "object", required: ["op"] }, precondition: { type: "object" }, confirm: { type: "string" } },
            },
          },
        },
      },
      responses: responses("MutationResult"),
    },
  };
  paths["/commands"] = { get: { operationId: "commands.list", summary: "List commands with JSON schemas", responses: responses("Command list") } };
  paths["/commands/execute"] = {
    post: {
      operationId: "commands.execute",
      summary: "Execute any command by id",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", required: ["command"], properties: { command: { type: "string" }, args: { type: "object" }, confirm: { type: "string" } } } } },
      },
      responses: responses("ExecuteResponse"),
    },
  };
  return {
    openapi: "3.1.0",
    info: { title: "Lanes Git Graph API", version: "1.0.0", description: "Every route maps to a command in the shared registry. See x-commands for all command schemas." },
    servers: [{ url: "/api/v1" }],
    paths,
    "x-commands": registry.list().map(describeCommand),
  };
}
