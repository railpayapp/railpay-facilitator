import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Runtime-neutral library.
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
    target: "es2022",
    outDir: "dist",
    platform: "neutral",
  },
  {
    // Node only: the runnable server (`node dist/node.js`).
    entry: ["src/node.ts"],
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    target: "node22",
    outDir: "dist",
    platform: "node",
  },
]);
