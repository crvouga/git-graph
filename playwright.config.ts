import { defineConfig, devices } from "@playwright/test";

// E2E tests run against the production build (pnpm build) started by test/e2e/global-setup.ts.
export default defineConfig({
  testDir: "test/e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-results.json" }]],
  globalSetup: "./test/e2e/global-setup.ts",
  globalTeardown: "./test/e2e/global-teardown.ts",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1200, height: 720 },
    colorScheme: "dark",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
