/**
 * Async utilities
 */

export class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`max concurrent operations must be > 0 (got ${limit})`);
    }
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
