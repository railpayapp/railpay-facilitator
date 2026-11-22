/** Fixed-window counter per key. In memory: per process (Node) or per isolate (Workers). */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  /**
   * @param limit requests per window per key. 0 disables the limiter.
   * @param windowMs window length.
   */
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private now: () => number = Date.now,
  ) {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError("limit must be a non-negative integer");
  }

  /** Count one request for `key`. Returns null when allowed, else the seconds until the window resets. */
  take(key: string): number | null {
    if (this.limit === 0) return null;
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.sweep(t);
      this.windows.set(key, { start: t, count: 1 });
      return null;
    }
    if (w.count >= this.limit) return Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
    w.count++;
    return null;
  }

  private sweep(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}

export class QueueTimeoutError extends Error {
  constructor() {
    super("timed out waiting for the settlement queue");
    this.name = "QueueTimeoutError";
  }
}

/**
 * One holder at a time, FIFO. The operator key sends one transaction at a time and waits for its receipt, so the
 * account nonce read from the chain is always the next free one.
 */
export class Mutex {
  private locked = false;
  private queue: (() => void)[] = [];

  get waiting() {
    return this.queue.length;
  }

  /** Resolves with a release function. Rejects with QueueTimeoutError after `timeoutMs` in the queue. */
  acquire(timeoutMs = Number.POSITIVE_INFINITY): Promise<() => void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.locked = false;
    };
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = () => {
        if (timer) clearTimeout(timer);
        resolve(release);
      };
      this.queue.push(waiter);
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) {
            this.queue.splice(i, 1);
            reject(new QueueTimeoutError());
          }
        }, timeoutMs);
      }
    });
  }

  async run<T>(f: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const release = await this.acquire(timeoutMs);
    try {
      return await f();
    } finally {
      release();
    }
  }
}
