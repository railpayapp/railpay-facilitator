/**
 * Where the facilitator remembers each authorization it touched, so one authorization never gets two transactions
 * from this operator and never gets two successful settle answers.
 *
 * - `memoryStore()`: one process only, lost on restart.
 * - `sqlStore(driver)`: any SQLite with `INSERT … ON CONFLICT DO NOTHING RETURNING` (the Durable Object store and
 *   `railpay-facilitator/sqlite` for Node). Survives restarts.
 */

export type SettlementState =
  /** Claimed, nothing broadcast yet. */
  | "settling"
  /** A signed transaction exists and may have been broadcast. Its hash and raw bytes are stored. */
  | "submitted"
  /** Confirmed with the exact Transfer log, and the one success answer was handed out. */
  | "settled"
  /** The transaction confirmed but reverted, or confirmed without the exact Transfer log. Terminal. */
  | "failed";

export type SettlementRecord = {
  state: SettlementState;
  payer: string;
  payTo: string;
  amount: string;
  /** Transaction hash (submitted, settled, failed). */
  tx?: string;
  /** Signed raw transaction, kept so the identical transaction can be rebroadcast. */
  raw?: string;
  /** Operator account nonce of `raw`. */
  operatorNonce?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms after which the record may be deleted: the authorization can no longer land on-chain. */
  expiresAt: number;
};

export interface SettlementStore {
  /** Insert if the key is absent. Returns false if it exists. Must be atomic for every process sharing the store. */
  claim(key: string, record: SettlementRecord): Promise<boolean>;
  get(key: string): Promise<SettlementRecord | undefined>;
  /** Insert or replace. */
  put(key: string, record: SettlementRecord): Promise<void>;
  delete(key: string): Promise<void>;
  /** Delete records whose `expiresAt` is before `now`. Returns how many were deleted. */
  prune(now: number): Promise<number>;
}

/** In-process store. Safe for one Node process; not shared between instances. */
export function memoryStore(): SettlementStore {
  const m = new Map<string, SettlementRecord>();
  return {
    async claim(key, record) {
      if (m.has(key)) return false;
      m.set(key, { ...record });
      return true;
    },
    async get(key) {
      const r = m.get(key);
      return r ? { ...r } : undefined;
    },
    async put(key, record) {
      m.set(key, { ...record });
    },
    async delete(key) {
      m.delete(key);
    },
    async prune(now) {
      let n = 0;
      for (const [k, r] of m) {
        if (r.expiresAt < now) {
          m.delete(k);
          n++;
        }
      }
      return n;
    },
  };
}

/** The two operations `sqlStore` needs from a synchronous SQLite binding. */
export type SqlDriver = {
  exec(sql: string, ...params: (string | number | null)[]): void;
  /** First row of a query, or undefined. */
  one(sql: string, ...params: (string | number | null)[]): Record<string, unknown> | undefined;
};

export const SETTLEMENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS settlements (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS settlements_expires_at ON settlements (expires_at);`;

/**
 * A store on SQLite. `claim` is one `INSERT … ON CONFLICT(key) DO NOTHING RETURNING key` statement, which is atomic
 * across every connection to the same database.
 */
export function sqlStore(driver: SqlDriver): SettlementStore {
  for (const stmt of SETTLEMENTS_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) driver.exec(stmt);
  const parse = (row: Record<string, unknown> | undefined) => (row ? (JSON.parse(String(row.value)) as SettlementRecord) : undefined);
  return {
    async claim(key, record) {
      const row = driver.one(
        "INSERT INTO settlements (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING RETURNING key",
        key,
        JSON.stringify(record),
        record.expiresAt,
      );
      return row !== undefined;
    },
    async get(key) {
      return parse(driver.one("SELECT value FROM settlements WHERE key = ?", key));
    },
    async put(key, record) {
      driver.exec(
        "INSERT INTO settlements (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
        key,
        JSON.stringify(record),
        record.expiresAt,
      );
    },
    async delete(key) {
      driver.exec("DELETE FROM settlements WHERE key = ?", key);
    },
    async prune(now) {
      const row = driver.one("SELECT COUNT(*) AS n FROM settlements WHERE expires_at < ?", now);
      driver.exec("DELETE FROM settlements WHERE expires_at < ?", now);
      return Number(row?.n ?? 0);
    },
  };
}
