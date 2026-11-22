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
]);
