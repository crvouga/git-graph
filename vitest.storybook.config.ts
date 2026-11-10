// Every story is a browser test: it must render without errors and its play function must pass.
//   pnpm test:storybook
import { defineConfig, mergeConfig } from "vitest/config";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    plugins: [storybookTest({ configDir: ".storybook", storybookScript: "pnpm storybook" })],
    // Imported lazily (git reader, a11y checks); pre-bundle so Vite does not reload mid-run.
    optimizeDeps: { include: ["fflate", "@storybook/addon-a11y > axe-core"] },
    test: {
      name: "storybook",
      environment: "node", // stories run in a real browser; stops vite-plugin-solid defaulting to jsdom
      testTimeout: 30_000,
      browser: {
        enabled: true,
        headless: true,
        provider: playwright({ contextOptions: { timezoneId: "UTC", locale: "en-US" } }),
        instances: [{ browser: "chromium", viewport: { width: 1200, height: 720 } }],
      },
    },
  }),
);
