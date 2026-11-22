import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { sqliteStore } from "../src/sqlite.js";
import { memoryStore, type SettlementRecord, type SettlementStore } from "../src/store.js";

const record = (over: Partial<SettlementRecord> = {}): SettlementRecord => ({
  state: "settling",
  payer: "0xa",
  payTo: "0xb",
  amount: "1000",
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 10_000,
  ...over,
});

const dir = mkdtempSync(join(tmpdir(), "railpay-facilitator-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const stores: [string, () => SettlementStore][] = [
  ["memoryStore", () => memoryStore()],
  ["sqliteStore(:memory:)", () => sqliteStore(":memory:")],
];

describe.each(stores)("%s", (_name, make) => {
  it("claims a key once", async () => {
    const s = make();
    expect(await s.claim("k", record())).toBe(true);
    expect(await s.claim("k", record({ state: "submitted" }))).toBe(false);
    expect((await s.get("k"))?.state).toBe("settling");
  });

  it("puts, gets and deletes", async () => {
    const s = make();
    await s.put("k", record({ state: "submitted", tx: "0x01", raw: "0x02", operatorNonce: 7 }));
    expect(await s.get("k")).toMatchObject({ state: "submitted", tx: "0x01", raw: "0x02", operatorNonce: 7 });
    await s.put("k", record({ state: "settled", tx: "0x01" }));
    expect((await s.get("k"))?.state).toBe("settled");
    await s.delete("k");
    expect(await s.get("k")).toBeUndefined();
    expect(await s.claim("k", record())).toBe(true);
  });

  it("prunes expired records only", async () => {
    const s = make();
    await s.put("old", record({ expiresAt: 100 }));
    await s.put("new", record({ expiresAt: 10_000 }));
    expect(await s.prune(5_000)).toBe(1);
    expect(await s.get("old")).toBeUndefined();
    expect(await s.get("new")).toBeDefined();
  });

  it("returns copies, not live objects", async () => {
    const s = make();
    await s.put("k", record());
    const r = await s.get("k");
    if (r) r.state = "failed";
    expect((await s.get("k"))?.state).toBe("settling");
  });
});

describe("sqliteStore on a file", () => {
  it("keeps claims atomic across connections and survives a reopen", async () => {
    const path = join(dir, "settlements.db");
    const a = sqliteStore(path);
    const b = sqliteStore(path);
    const results = await Promise.all([a.claim("k", record()), b.claim("k", record())]);
    expect(results.filter(Boolean)).toHaveLength(1);
    a.close();
    b.close();
    const c = sqliteStore(path);
    expect(await c.claim("k", record())).toBe(false);
    expect((await c.get("k"))?.state).toBe("settling");
    c.close();
  });
});
