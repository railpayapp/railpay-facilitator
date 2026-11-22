import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CHAIN_ID, NETWORK, VERSION } from "../src/index.js";

describe("package", () => {
  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("targets Robinhood Chain", () => {
    expect(NETWORK).toBe(`eip155:${CHAIN_ID}`);
  });
});
