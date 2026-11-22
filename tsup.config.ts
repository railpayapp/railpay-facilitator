import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Runtime-neutral library and the Cloudflare Workers entry.
    entry: ["src/index.ts", "src/worker.ts"],
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
    // Node only: the SQLite store (node:sqlite) and the runnable server (`node dist/node.js`).
    entry: ["src/sqlite.ts", "src/node.ts"],
    format: ["esm"],
    dts: { entry: ["src/sqlite.ts"] },
    sourcemap: true,
    clean: false,
    splitting: false,
    target: "node22",
    outDir: "dist",
    platform: "node",
    // node:sqlite only exists with the prefix.
    removeNodeProtocol: false,
  },
]);
