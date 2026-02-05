import { VM, type VMOptions } from "../../src/vm";

class Semaphore {
  private queue: Array<() => void> = [];

  constructor(private count: number) {}

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.count += 1;
  }
}

type VmEntry = {
  vm: VM;
  semaphore: Semaphore;
};

const pool = new Map<string, VmEntry>();
const pending = new Map<string, Promise<VmEntry>>();

async function getEntry(key: string, options: VMOptions): Promise<VmEntry> {
  const existing = pool.get(key);
  if (existing) {
    return existing;
  }

  const inFlight = pending.get(key);
  if (inFlight) {
    return inFlight;
  }

  const created = (async () => {
    try {
      const vm = await VM.create(options);
      const entry = { vm, semaphore: new Semaphore(1) };
      pool.set(key, entry);
      return entry;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, created);
  return created;
}

export async function withVm<T>(
  key: string,
  options: VMOptions,
  fn: (vm: VM) => Promise<T>
): Promise<T> {
  const entry = await getEntry(key, options);
  await entry.semaphore.acquire();
  try {
    return await fn(entry.vm);
  } finally {
    entry.semaphore.release();
  }
}

export async function closeAllVms(): Promise<void> {
  const entries = Array.from(pool.values());
  pool.clear();
  pending.clear();
  await Promise.all(entries.map(({ vm }) => vm.stop()));
}
