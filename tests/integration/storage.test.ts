import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  CacheEntry,
  HashedKey,
  ResolvedSWROptions,
  FetcherCtx,
  CacheStorage,
} from "../../src/types/index.ts";
import type { Observer } from "../../src/cache/types.ts";
import { store } from "../../src/cache/store.ts";

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

let observerIdCounter = 0;

function makeObserver<Data = unknown>(
  hashedKey: HashedKey,
  overrides: Partial<Observer<Data>> = {},
): Observer<Data> {
  return {
    id: `test-observer-${++observerIdCounter}`,
    hashedKey,
    lastRawKey: hashedKey,
    hasData: false,
    onData: vi.fn(),
    onError: vi.fn(),
    onFetchStatusChange: vi.fn(),
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ResolvedSWROptions> = {}): ResolvedSWROptions {
  return {
    enabled: true,
    eagerness: "visible",
    staleTime: 30_000,
    cacheTime: 300_000,
    revalidateOn: ["focus", "reconnect"],
    refreshInterval: 0,
    dedupingInterval: 2_000,
    retry: 3,
    retryInterval: 1_000,
    timeout: 30_000,
    ...overrides,
  } as ResolvedSWROptions;
}

function makeFetcher<Data>(
  data: Data,
  delay = 0,
): ReturnType<typeof vi.fn<(ctx: FetcherCtx) => Promise<Data>>> {
  return vi.fn(
    (_ctx: FetcherCtx) =>
      new Promise<Data>((resolve) => {
        if (delay > 0) {
          setTimeout(() => resolve(data), delay);
        } else {
          Promise.resolve().then(() => resolve(data));
        }
      }),
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function makeMockStorage(entries: Record<string, CacheEntry> = {}): CacheStorage & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
  size: ReturnType<typeof vi.fn>;
} {
  const data = new Map<string, CacheEntry>(Object.entries(entries));
  return {
    get: vi.fn((key: HashedKey) => data.get(key) ?? null) as any,
    set: vi.fn((key: HashedKey, entry: CacheEntry) => {
      data.set(key, entry);
    }),
    delete: vi.fn((key: HashedKey) => {
      data.delete(key);
    }),
    clear: vi.fn(() => {
      data.clear();
    }),
    keys: vi.fn(() => [...data.keys()] as HashedKey[]),
    size: vi.fn(() => data.size),
  };
}

function makeAsyncMockStorage(entries: Record<string, CacheEntry> = {}): CacheStorage & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
  size: ReturnType<typeof vi.fn>;
} {
  const data = new Map<string, CacheEntry>(Object.entries(entries));
  return {
    get: vi.fn(async (key: HashedKey) => data.get(key) ?? null) as any,
    set: vi.fn(async (key: HashedKey, entry: CacheEntry) => {
      data.set(key, entry);
    }),
    delete: vi.fn(async (key: HashedKey) => {
      data.delete(key);
    }),
    clear: vi.fn(async () => {
      data.clear();
    }),
    keys: vi.fn(async () => [...data.keys()] as HashedKey[]),
    size: vi.fn(async () => data.size),
  };
}

// ═══════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.useFakeTimers();
  store._reset();
  observerIdCounter = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════
// CacheStorage hydration and persistence
// ═══════════════════════════════════════════════════════════════

describe("CacheStorage hydration and persistence", () => {
  const KEY = "s:/api/users" as HashedKey;
  const KEY2 = "s:/api/posts" as HashedKey;

  describe("hydration via initStorage", () => {
    it("hydrates cache from storage on initStorage", async () => {
      const entry1: CacheEntry<string> = { data: "user-data", timestamp: 1000 };
      const entry2: CacheEntry<number> = { data: 42, timestamp: 2000 };

      const storage = makeMockStorage({
        [KEY]: entry1,
        [KEY2]: entry2,
      });

      await store.initStorage(storage);

      const cached1 = store.getCache<string>(KEY);
      expect(cached1).not.toBeNull();
      expect(cached1!.data).toBe("user-data");
      expect(cached1!.timestamp).toBe(1000);

      const cached2 = store.getCache<number>(KEY2);
      expect(cached2).not.toBeNull();
      expect(cached2!.data).toBe(42);
      expect(cached2!.timestamp).toBe(2000);

      expect(storage.keys).toHaveBeenCalledTimes(1);
      expect(storage.get).toHaveBeenCalledTimes(2);
    });

    it("handles empty storage", async () => {
      const storage = makeMockStorage({});

      await expect(store.initStorage(storage)).resolves.toBeUndefined();

      expect(store.getCache(KEY)).toBeNull();
      expect(storage.keys).toHaveBeenCalledTimes(1);
      expect(storage.get).not.toHaveBeenCalled();
    });

    it("handles async storage", async () => {
      const entry: CacheEntry<string> = { data: "async-data", timestamp: 3000 };

      const storage = makeAsyncMockStorage({
        [KEY]: entry,
      });

      await store.initStorage(storage);

      const cached = store.getCache<string>(KEY);
      expect(cached).not.toBeNull();
      expect(cached!.data).toBe("async-data");
      expect(cached!.timestamp).toBe(3000);

      expect(storage.keys).toHaveBeenCalledTimes(1);
      expect(storage.get).toHaveBeenCalledWith(KEY);
    });

    it("skips hydration when no storage provided", async () => {
      // Pre-populate cache to verify it is not cleared
      store.setCache(KEY, { data: "existing", timestamp: 500 });

      await expect(store.initStorage(undefined)).resolves.toBeUndefined();

      // Existing cache should remain untouched
      const cached = store.getCache<string>(KEY);
      expect(cached).not.toBeNull();
      expect(cached!.data).toBe("existing");
    });
  });

  describe("persistence on cache operations", () => {
    it("persists cache entries to storage on setCache", async () => {
      const storage = makeMockStorage();
      await store.initStorage(storage);

      const entry: CacheEntry<string> = { data: "hello", timestamp: Date.now() };
      store.setCache(KEY, entry);

      expect(storage.set).toHaveBeenCalledTimes(1);
      expect(storage.set).toHaveBeenCalledWith(KEY, entry);
    });

    it("persists on successful fetch", async () => {
      const storage = makeMockStorage();
      await store.initStorage(storage);

      const observer = makeObserver(KEY);
      const opts = makeOptions({ cacheTime: 300_000 });
      store.attachObserver(KEY, observer, opts);

      const fetcher = makeFetcher("fetched-data");
      store.ensureFetch(KEY, "/api/users", fetcher);
      await flush();

      // storage.set should have been called with the fetched data
      expect(storage.set).toHaveBeenCalled();
      const lastCall = storage.set.mock.calls[storage.set.mock.calls.length - 1];
      expect(lastCall[0]).toBe(KEY);
      expect(lastCall[1].data).toBe("fetched-data");
    });

    it("deletes from storage on deleteCache", async () => {
      const storage = makeMockStorage({
        [KEY]: { data: "to-delete", timestamp: 1000 },
      });
      await store.initStorage(storage);

      store.deleteCache(KEY);

      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith(KEY);
    });

    it("clears storage on clearCache", async () => {
      const storage = makeMockStorage({
        [KEY]: { data: "a", timestamp: 1 },
        [KEY2]: { data: "b", timestamp: 2 },
      });
      await store.initStorage(storage);

      store.clearCache();

      expect(storage.clear).toHaveBeenCalledTimes(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// GAP-ST2: initStorage timestamp comparison
// ═══════════════════════════════════════════════════════════════

describe("initStorage timestamp comparison", () => {
  it("should keep existing cacheMap entry when it is newer than storage entry", async () => {
    // Pre-populate cacheMap with newer entry
    store.setCache("key-a" as HashedKey, { data: "memory-new", timestamp: 5000 });

    // Create a storage that has an older entry for same key
    const mockStorage: CacheStorage = {
      get: <Data>(k: HashedKey) =>
        k === ("key-a" as HashedKey) ? { data: "storage-old" as Data, timestamp: 1000 } : null,
      set: () => {},
      delete: () => {},
      clear: () => {},
      keys: () => ["key-a" as HashedKey],
      size: () => 1,
    };

    await store.initStorage(mockStorage);

    // Memory entry (newer) should be kept
    const result = store.getCache("key-a" as HashedKey);
    expect(result!.data).toBe("memory-new");
    expect(result!.timestamp).toBe(5000);
  });

  it("should replace existing cacheMap entry when storage entry is newer", async () => {
    store.setCache("key-b" as HashedKey, { data: "memory-old", timestamp: 1000 });

    const mockStorage: CacheStorage = {
      get: <Data>(k: HashedKey) =>
        k === ("key-b" as HashedKey) ? { data: "storage-new" as Data, timestamp: 5000 } : null,
      set: () => {},
      delete: () => {},
      clear: () => {},
      keys: () => ["key-b" as HashedKey],
      size: () => 1,
    };

    await store.initStorage(mockStorage);

    const result = store.getCache("key-b" as HashedKey);
    expect(result!.data).toBe("storage-new");
    expect(result!.timestamp).toBe(5000);
  });
});
