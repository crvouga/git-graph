// Apply Lanes' database migrations to the allocated schema, then exit.
//
//   pnpm db:migrate                 # DATABASE_URL from the environment
//   pnpm db:migrate:vault           # DATABASE_URL injected from Vault (dev) by personal infra-vault run
//
// The server also migrates at boot (MIGRATE_ON_BOOT, default on). Never prints DATABASE_URL.

import { connectDb } from "../src/server/db.ts";
import { migrate, MIGRATIONS } from "../src/server/migrations.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required (run under `personal infra-vault run`, or use pnpm db:migrate:vault)");
  process.exit(2);
}
const db = connectDb(url, { schema: process.env.DATABASE_SCHEMA || "lanes", max: 1 });
try {
  const applied = await migrate(db);
  console.log(applied.length ? `applied ${applied.join(", ")} in schema "${db.schema}"` : `schema "${db.schema}" is up to date (${MIGRATIONS.length} migrations)`);
} catch (e) {
  console.error(`migration failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
