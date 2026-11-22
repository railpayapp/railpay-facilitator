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
