/**
 * Async utilities
 */

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
