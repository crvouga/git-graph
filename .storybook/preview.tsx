import type { Preview } from "storybook-solidjs-vite";
import { withThemeByDataAttribute } from "@storybook/addon-themes";
import "../src/web/styles.css";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
    // Violations show in the Accessibility panel. Existing contrast and grid-ARIA issues keep this at
    // "todo"; switch to "error" once they are fixed so new ones fail `pnpm test:storybook`.
    a11y: { test: "todo" },
    options: {
      storySort: { order: ["Docs", ["Introduction"], "Foundations", "App", "Components", "Overlays"] },
    },
  },
  decorators: [
    withThemeByDataAttribute({ themes: { dark: "dark", light: "light" }, defaultTheme: "dark", attributeName: "data-theme", parentSelector: "html" }),
  ],
  tags: ["autodocs"],
};

export default preview;
