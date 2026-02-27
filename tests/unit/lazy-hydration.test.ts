import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { CacheEntry, CacheStorage, HashedKey, SWRError } from "../../src/types/index.ts";
import type { Observer } from "../../src/cache/types.ts";
import { store } from "../../src/cache/store.ts";

/** In-memory storage tracking calls */
function createTestStorage(
  initial?: Map<HashedKey, CacheEntry>,
): CacheStorage & { getCalls: HashedKey[]; keysCalls: number } {
  const _store = new Map<HashedKey, CacheEntry>(initial ?? []);
  const getCalls: HashedKey[] = [];
  let keysCalls = 0;

  return {
    getCalls,
    get keysCalls() {
      return keysCalls;
    },
    get<Data>(key: HashedKey) {
      getCalls.push(key);
      return (_store.get(key) as CacheEntry<Data>) ?? null;
    },
    set<Data>(key: HashedKey, entry: CacheEntry<Data>) {
      _store.set(key, entry as CacheEntry);
    },
    delete(key: HashedKey) {
      _store.delete(key);
    },
    clear() {
      _store.clear();
    },
    keys() {
      keysCalls++;
      return [..._store.keys()];
    },
    size() {
      return _store.size;
    },
  };
}

function createTestObserver(hashedKey: HashedKey): Observer & {
  dataHistory: CacheEntry[];
} {
  const dataHistory: CacheEntry[] = [];
  return {
    id: `ob-${Math.random().toString(36).slice(2)}`,
    hashedKey,
    lastRawKey: hashedKey.slice(2),
    hasData: false,
    onData: (entry: CacheEntry) => {
      dataHistory.push(entry);
    },
    onError: (_error: SWRError) => {},
    onFetchStatusChange: (_status: string) => {},
    dataHistory,
  };
}

const DEFAULT_CONFIG = {
  enabled: true,
  eagerness: "visible" as const,
  staleTime: 30_000,
  cacheTime: 300_000,
  dedupingInterval: 2_000,
  revalidateOn: [] as string[],
  refreshInterval: 0,
  retry: 3,
  retryInterval: 1000,
  timeout: 30_000,
};

describe("Lazy hydration", () => {
  beforeEach(() => {
    store._reset();
  });

  afterEach(() => {
    store._reset();
  });

  it("should only call storage.keys() in lazy mode (no get calls during init)", async () => {
    const initial = new Map<HashedKey, CacheEntry>([
      ["s:k1" as HashedKey, { data: "v1", timestamp: 100 }],
      ["s:k2" as HashedKey, { data: "v2", timestamp: 200 }],
      ["s:k3" as HashedKey, { data: "v3", timestamp: 300 }],
    ]);
    const storage = createTestStorage(initial);

    await store.initStorage(storage, "lazy");

    // keys() should have been called once
    expect(storage.keysCalls).toBe(1);
    // get() should NOT have been called (lazy mode skips initial read)
    expect(storage.getCalls).toHaveLength(0);
  });

  it("should NOT have called storage.get after lazy init (data not preloaded)", async () => {
    const initial = new Map<HashedKey, CacheEntry>([
      ["s:k1" as HashedKey, { data: "v1", timestamp: 100 }],
    ]);
    const storage = createTestStorage(initial);

    await store.initStorage(storage, "lazy");

    // Storage.get should NOT have been called during init
    expect(storage.getCalls).toHaveLength(0);
    // Note: getCache triggers on-demand hydration, so we can't use it to check emptiness.
    // The test validates that no storage.get was issued during init.
  });

  it("should hydrate key on-demand when attachObserver is called", async () => {
    const initial = new Map<HashedKey, CacheEntry>([
      ["s:k1" as HashedKey, { data: "v1", timestamp: 100 }],
    ]);
    const storage = createTestStorage(initial);

    await store.initStorage(storage, "lazy");

    const observer = createTestObserver("s:k1" as HashedKey);
    store.attachObserver("s:k1" as HashedKey, observer, DEFAULT_CONFIG as any);

    // Storage.get should have been called for this key
    expect(storage.getCalls).toContain("s:k1");
    // Observer should have received the data
    expect(observer.dataHistory).toHaveLength(1);
    expect(observer.dataHistory[0]!.data).toBe("v1");
  });

  it("should hydrate key on-demand when getCache is called", async () => {
    const initial = new Map<HashedKey, CacheEntry>([
      ["s:k1" as HashedKey, { data: "v1", timestamp: 100 }],
    ]);
    const storage = createTestStorage(initial);

    await store.initStorage(storage, "lazy");

    const entry = store.getCache("s:k1" as HashedKey);
    expect(entry?.data).toBe("v1");
    expect(storage.getCalls).toContain("s:k1");
  });

  it("should not hydrate a key that is not in storage", async () => {
    const storage = createTestStorage(new Map());
    await store.initStorage(storage, "lazy");

    const entry = store.getCache("s:unknown" as HashedKey);
    expect(entry).toBeNull();
    // get should NOT be called for unknown keys
    expect(storage.getCalls).toHaveLength(0);
  });

  it("should skip storage read for already-hydrated keys", async () => {
    const initial = new Map<HashedKey, CacheEntry>([
      ["s:k1" as HashedKey, { data: "v1", timestamp: 100 }],
    ]);
    const storage = createTestStorage(initial);

    await store.initStorage(storage, "lazy");

    // First access: hydrates
    store.getCache("s:k1" as HashedKey);
    expect(storage.getCalls).toHaveLength(1);

    // Second access: already hydrated, no storage call
    store.getCache("s:k1" as HashedKey);
    expect(storage.getCalls).toHaveLength(1);
  });

  it("should use newer timestamp when memory cache already has data", async () => {
    const initial = new Map<HashedKey, CacheEntry>([
      ["s:k1" as HashedKey, { data: "storage-old", timestamp: 50 }],
    ]);
    const storage = createTestStorage(initial);

    await store.initStorage(storage, "lazy");

    // Manually set a newer entry in memory before hydration triggers
    store.setCache("s:k1" as HashedKey, { data: "memory-new", timestamp: 200 });

    // Trigger hydration via getCache - should keep memory version (newer)
    const entry = store.getCache("s:k1" as HashedKey);
    expect(entry?.data).toBe("memory-new");
    expect(entry?.timestamp).toBe(200);
  });

  it("should apply storage entry when cacheMap has no prior data for key", async () => {
    // This test verifies that lazy hydration properly loads from storage
    // when the key has never been set in memory
    const initial = new Map<HashedKey, CacheEntry>([
      ["s:k1" as HashedKey, { data: "from-storage", timestamp: 500 }],
    ]);
    const storage = createTestStorage(initial);

    await store.initStorage(storage, "lazy");

    // Key not yet in cacheMap, getCache triggers hydration from storage
    const entry = store.getCache("s:k1" as HashedKey);
    expect(entry?.data).toBe("from-storage");
    expect(entry?.timestamp).toBe(500);
  });

  it("should load all entries in eager mode (default behavior)", async () => {
    const initial = new Map<HashedKey, CacheEntry>([
      ["s:k1" as HashedKey, { data: "v1", timestamp: 100 }],
      ["s:k2" as HashedKey, { data: "v2", timestamp: 200 }],
    ]);
    const storage = createTestStorage(initial);

    // Eager mode (default)
    await store.initStorage(storage, "eager");

    // All entries should be in cacheMap immediately
    expect(store.getCache("s:k1" as HashedKey)?.data).toBe("v1");
    expect(store.getCache("s:k2" as HashedKey)?.data).toBe("v2");
    // get should have been called for each key
    expect(storage.getCalls).toHaveLength(2);
  });

  it("should allow re-hydration when async storage.get() fails", async () => {
    let callCount = 0;
    const storage: CacheStorage = {
      get(_key: HashedKey) {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("storage error"));
        }
        return Promise.resolve({ data: "recovered", timestamp: 100 } as CacheEntry);
      },
      set() {
        return Promise.resolve();
      },
      delete() {
        return Promise.resolve();
      },
      clear() {
        return Promise.resolve();
      },
      keys() {
        return Promise.resolve(["s:k1" as HashedKey]);
      },
      size() {
        return Promise.resolve(1);
      },
    };

    await store.initStorage(storage, "lazy");

    // First attempt: storage.get() rejects, key should be unmarked from hydrated
    const entry1 = store.getCache("s:k1" as HashedKey);
    // getCache triggers async hydration but returns sync (no data yet in cache)
    expect(entry1).toBeNull();
    // Wait for async rejection to settle
    await new Promise((r) => setTimeout(r, 0));

    // Second attempt: should retry since the key was un-hydrated on failure
    const observer = createTestObserver("s:k1" as HashedKey);
    store.attachObserver("s:k1" as HashedKey, observer, DEFAULT_CONFIG as any);
    // Wait for async hydration to settle
    await new Promise((r) => setTimeout(r, 0));

    expect(callCount).toBe(2);
    expect(observer.dataHistory).toHaveLength(1);
    expect(observer.dataHistory[0]!.data).toBe("recovered");
  });

  it("should default to eager mode when hydration is not specified", async () => {
    const initial = new Map<HashedKey, CacheEntry>([
      ["s:k1" as HashedKey, { data: "v1", timestamp: 100 }],
    ]);
    const storage = createTestStorage(initial);

    // No hydration mode specified (defaults to eager)
    await store.initStorage(storage);

    expect(store.getCache("s:k1" as HashedKey)?.data).toBe("v1");
    expect(storage.getCalls).toHaveLength(1);
  });
});
