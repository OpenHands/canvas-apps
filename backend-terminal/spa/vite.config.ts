import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  build: {
    emptyOutDir: true,
    outDir: resolve(import.meta.dirname, "../sidecar-dist/public"),
    sourcemap: false,
  },
});
