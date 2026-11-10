import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const api = process.env.LANES_DEV_SERVER ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  root: ".",
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    reportCompressedSize: false,
    rollupOptions: { input: "index.html" },
  },
  worker: { format: "es" },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: api, changeOrigin: false, ws: false },
      "/auth": { target: api, changeOrigin: false },
    },
  },
  preview: { port: 4173 },
});
