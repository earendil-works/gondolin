/**
 * Async utilities
 */

export class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`max concurrent operations must be > 0 (got ${limit})`);
    }
    this.limit = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }

    this.active += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

/**
 * Deduplicate concurrent calls to an async operation.
 *
 * While a call is in-flight, subsequent `run()` invocations return the same
 * promise. Once it settles, the next `run()` triggers a new call.
 */
export class AsyncSingleflight<T> {
  private promise: Promise<T> | null = null;

  run(fn: () => Promise<T>): Promise<T> {
    if (this.promise) return this.promise;

    this.promise = fn().finally(() => {
      this.promise = null;
    });

    return this.promise;
  }
}
