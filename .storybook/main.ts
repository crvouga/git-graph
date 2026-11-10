import type { StorybookConfig } from "storybook-solidjs-vite";
import { fixtureRepo } from "./fixture-repo.ts";

// Storybook reuses vite.config.ts (Solid + Tailwind); this only adds what stories need.
const config: StorybookConfig = {
  framework: { name: "storybook-solidjs-vite", options: {} },
  stories: ["../src/web/**/*.mdx", "../src/web/**/*.stories.tsx"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-themes", "@storybook/addon-vitest", "@storybook/addon-mcp"],
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  async viteFinal(cfg) {
    cfg.plugins = [...(cfg.plugins ?? []), fixtureRepo()];
    // Read by src/web/app/env.ts: in-memory URL, no saved preferences.
    cfg.define = { ...cfg.define, "import.meta.env.LANES_STORYBOOK": "true" };
    // The app's dev proxy and fixed port do not apply here.
    cfg.server = { ...cfg.server, proxy: undefined, strictPort: false };
    return cfg;
  },
};

export default config;
