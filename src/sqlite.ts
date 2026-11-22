import { DatabaseSync } from "node:sqlite";

import { sqlStore, type SettlementStore, type SqlDriver } from "./store.js";

/**
 * A settlement store in a SQLite file, for Node 22.13+ (`node:sqlite`). It survives restarts, and `claim` stays atomic
 * across every connection to the same file. Pass ":memory:" for a throwaway database.
 */
export function sqliteStore(path: string): SettlementStore & { close(): void } {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  const driver: SqlDriver = {
    exec: (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
    one: (sql, ...params) => db.prepare(sql).get(...params) as Record<string, unknown> | undefined,
  };
  return Object.assign(sqlStore(driver), { close: () => db.close() });
}

export type { SettlementStore } from "./store.js";
