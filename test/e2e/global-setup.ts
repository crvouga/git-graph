import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, startHarness } from "./harness.ts";

export default async function globalSetup() {
  mkdirSync(join(ROOT, "test-results"), { recursive: true });
  const s = await startHarness();
  console.log(`e2e: app ${s.appOrigin}, companion ${s.companionUrl}, fixtures ${s.fixturesRoot}`);
}
