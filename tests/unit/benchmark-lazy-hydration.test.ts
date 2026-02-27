import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { CacheEntry, CacheStorage, HashedKey } from "../../src/types/index.ts";
import { store } from "../../src/cache/store.ts";

function createFakeStorage(entryCount: number): CacheStorage & { getCalls: number } {
  const data = new Map<HashedKey, CacheEntry>();
  for (let i = 0; i < entryCount; i++) {
    const key = `s:key${i}` as HashedKey;
    data.set(key, { data: { value: i }, timestamp: Date.now() });
  }

  const tracker = { getCalls: 0 };

  return {
    get getCalls() {
      return tracker.getCalls;
    },
    get(key: HashedKey): CacheEntry | null {
      tracker.getCalls++;
      return data.get(key) ?? null;
    },
    set(key: HashedKey, entry: CacheEntry): void {
      data.set(key, entry);
    },
    delete(key: HashedKey): void {
      data.delete(key);
    },
    clear(): void {
      data.clear();
    },
    keys(): HashedKey[] {
      return [...data.keys()];
    },
    size(): number {
      return data.size;
    },
  };
}

describe("SC-005: Lazy hydration init time benchmark", () => {
  beforeEach(() => {
    store._reset();
  });

  afterEach(() => {
    store._reset();
  });

  it("lazy hydration makes 0 get() calls during init vs 1000 for eager (>=50% reduction)", async () => {
    const ENTRY_COUNT = 1000;

    // Scenario A: eager hydration
    const storageEager = createFakeStorage(ENTRY_COUNT);
    await store.initStorage(storageEager, "eager");
    const eagerGetCalls = storageEager.getCalls;

    // Scenario B: lazy hydration
    store._reset();
    const storageLazy = createFakeStorage(ENTRY_COUNT);
    await store.initStorage(storageLazy, "lazy");
    const lazyGetCalls = storageLazy.getCalls;

    // Eager loads all 1000 entries
    expect(eagerGetCalls).toBe(ENTRY_COUNT);

    // Lazy loads 0 entries during init
    expect(lazyGetCalls).toBe(0);

    // Reduction >= 50% (100% in this case)
    const reduction = (eagerGetCalls - lazyGetCalls) / eagerGetCalls;
    expect(reduction).toBeGreaterThanOrEqual(0.5);
  });
});
