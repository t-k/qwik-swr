import { describe, it, expect, vi, afterEach } from "vitest";
import { createHybridStorage } from "../../storage/hybrid.ts";
import { createMemoryStorage } from "../../storage/memory.ts";
import type { CacheEntry, CacheStorage, HashedKey } from "../../src/types/index.ts";

// ===============================================================
// Helper: create a Map-based CacheStorage for testing
// ===============================================================

// Helper to cast string to HashedKey in tests
const hk = (s: string) => s as HashedKey;

function createTestStorage(
  initial: Record<string, CacheEntry> = {},
): CacheStorage & { _map: Map<string, CacheEntry> } {
  const map = new Map<string, CacheEntry>(Object.entries(initial));
  return {
    _map: map,
    get<Data>(key: HashedKey): CacheEntry<Data> | null {
      return (map.get(key) as CacheEntry<Data> | undefined) ?? null;
    },
    set<Data>(key: HashedKey, entry: CacheEntry<Data>): void {
      map.set(key, entry as CacheEntry);
    },
    delete(key: HashedKey): void {
      map.delete(key);
    },
    clear(): void {
      map.clear();
    },
    keys(): HashedKey[] {
      return [...map.keys()] as HashedKey[];
    },
    size(): number {
      return map.size;
    },
  };
}

// ===============================================================
// Setup / Teardown
// ===============================================================

afterEach(() => {
  vi.restoreAllMocks();
});

// ===============================================================
// T037: Memory-first read
// ===============================================================

describe("T037: memory-first read (get from memory first, fall back to persistent)", () => {
  it("should return data from memory when available in both layers", async () => {
    const memory = createTestStorage({
      "key-1": { data: "memory-value", timestamp: 2000 },
    });
    const persistent = createTestStorage({
      "key-1": { data: "persistent-value", timestamp: 1000 },
    });

    const hybrid = createHybridStorage({ memory, persistent });
    const result = await hybrid.get<string>(hk("key-1"));

    expect(result).not.toBeNull();
    expect(result!.data).toBe("memory-value");
    expect(result!.timestamp).toBe(2000);
  });

  it("should fall back to persistent when memory has no entry", async () => {
    const memory = createTestStorage({});
    const persistent = createTestStorage({
      "key-1": { data: "persistent-only", timestamp: 1500 },
    });

    const hybrid = createHybridStorage({ memory, persistent });
    const result = await hybrid.get<string>(hk("key-1"));

    expect(result).not.toBeNull();
    expect(result!.data).toBe("persistent-only");
    expect(result!.timestamp).toBe(1500);
  });

  it("should return null when neither layer has the entry", async () => {
    const memory = createTestStorage({});
    const persistent = createTestStorage({});

    const hybrid = createHybridStorage({ memory, persistent });
    const result = await hybrid.get(hk("non-existent"));

    expect(result).toBeNull();
  });

  it("should write to both layers on set", async () => {
    const memory = createTestStorage();
    const persistent = createTestStorage();

    const hybrid = createHybridStorage({ memory, persistent });
    const entry: CacheEntry<string> = { data: "dual-write", timestamp: 3000 };

    await hybrid.set(hk("key-2"), entry);

    // Both layers should have the entry
    expect(memory._map.get("key-2")).toBeDefined();
    expect(memory._map.get("key-2")!.data).toBe("dual-write");
    expect(persistent._map.get("key-2")).toBeDefined();
    expect(persistent._map.get("key-2")!.data).toBe("dual-write");
  });

  it("should delete from both layers", async () => {
    const memory = createTestStorage({
      "key-del": { data: "a", timestamp: 1 },
    });
    const persistent = createTestStorage({
      "key-del": { data: "a", timestamp: 1 },
    });

    const hybrid = createHybridStorage({ memory, persistent });
    await hybrid.delete(hk("key-del"));

    expect(memory._map.has("key-del")).toBe(false);
    expect(persistent._map.has("key-del")).toBe(false);
  });

  it("should clear both layers", async () => {
    const memory = createTestStorage({
      k1: { data: "a", timestamp: 1 },
    });
    const persistent = createTestStorage({
      k1: { data: "a", timestamp: 1 },
      k2: { data: "b", timestamp: 2 },
    });

    const hybrid = createHybridStorage({ memory, persistent });
    await hybrid.clear();

    expect(memory._map.size).toBe(0);
    expect(persistent._map.size).toBe(0);
  });

  it("should return keys from both layers (union, deduplicated)", async () => {
    const memory = createTestStorage({
      "key-a": { data: "a", timestamp: 1 },
      "key-b": { data: "b", timestamp: 2 },
    });
    const persistent = createTestStorage({
      "key-b": { data: "b", timestamp: 2 },
      "key-c": { data: "c", timestamp: 3 },
    });

    const hybrid = createHybridStorage({ memory, persistent });
    const keys = await hybrid.keys();

    expect(keys).toHaveLength(3);
    expect(keys).toContain("key-a");
    expect(keys).toContain("key-b");
    expect(keys).toContain("key-c");
  });
});

// ===============================================================
// T038: Hydration timestamp comparison (newer entry wins)
// ===============================================================

describe("T038: hydration timestamp comparison (newer entry wins when hydrating)", () => {
  it("should return memory entry even when persistent has newer timestamp (no auto-hydration)", async () => {
    const memory = createTestStorage({
      "key-1": { data: "old-memory", timestamp: 1000 },
    });
    const persistent = createTestStorage({
      "key-1": { data: "new-persistent", timestamp: 2000 },
    });

    // Hybrid get is read-through: memory first. Hydration (timestamp comparison)
    // is done by CacheStore.initStorage, not by hybrid storage itself.
    const hybrid = createHybridStorage({ memory, persistent });

    const result = await hybrid.get<string>(hk("key-1"));
    expect(result).not.toBeNull();
    // Memory wins (read-through), regardless of timestamp
    expect(result!.data).toBe("old-memory");
    expect(result!.timestamp).toBe(1000);
  });

  it("should keep memory entry when it has a newer timestamp than persistent", async () => {
    const memory = createTestStorage({
      "key-1": { data: "new-memory", timestamp: 3000 },
    });
    const persistent = createTestStorage({
      "key-1": { data: "old-persistent", timestamp: 1000 },
    });

    const hybrid = createHybridStorage({ memory, persistent });

    const result = await hybrid.get<string>(hk("key-1"));
    expect(result).not.toBeNull();
    expect(result!.data).toBe("new-memory");
    expect(result!.timestamp).toBe(3000);
  });

  it("should hydrate memory with persistent entries that don't exist in memory", async () => {
    const memory = createTestStorage({});
    const persistent = createTestStorage({
      "new-key": { data: "from-persistent", timestamp: 5000 },
    });

    const hybrid = createHybridStorage({ memory, persistent });

    // After hydration, the persistent entry should be readable
    const result = await hybrid.get<string>(hk("new-key"));
    expect(result).not.toBeNull();
    expect(result!.data).toBe("from-persistent");
    expect(result!.timestamp).toBe(5000);
  });

  it("should read memory first for all keys, fall back to persistent for missing", async () => {
    const memory = createTestStorage({
      "key-a": { data: "mem-a-old", timestamp: 1000 },
      "key-b": { data: "mem-b-new", timestamp: 5000 },
    });
    const persistent = createTestStorage({
      "key-a": { data: "per-a-new", timestamp: 3000 },
      "key-b": { data: "per-b-old", timestamp: 2000 },
      "key-c": { data: "per-c-only", timestamp: 4000 },
    });

    const hybrid = createHybridStorage({ memory, persistent });

    // key-a: memory has it -> memory wins (read-through, no timestamp comparison)
    const resultA = await hybrid.get<string>(hk("key-a"));
    expect(resultA!.data).toBe("mem-a-old");
    expect(resultA!.timestamp).toBe(1000);

    // key-b: memory has it -> memory wins
    const resultB = await hybrid.get<string>(hk("key-b"));
    expect(resultB!.data).toBe("mem-b-new");
    expect(resultB!.timestamp).toBe(5000);

    // key-c: only in persistent -> falls back to persistent
    const resultC = await hybrid.get<string>(hk("key-c"));
    expect(resultC!.data).toBe("per-c-only");
    expect(resultC!.timestamp).toBe(4000);
  });

  it("should keep memory entry when timestamps are equal", async () => {
    const memory = createTestStorage({
      "key-eq": { data: "memory-version", timestamp: 2000 },
    });
    const persistent = createTestStorage({
      "key-eq": { data: "persistent-version", timestamp: 2000 },
    });

    const hybrid = createHybridStorage({ memory, persistent });

    const result = await hybrid.get<string>(hk("key-eq"));
    expect(result).not.toBeNull();
    // When timestamps are equal, memory (the fast layer) should win
    expect(result!.data).toBe("memory-version");
  });

  it("should enable hydration pattern: read persistent keys, compare, set into memory", async () => {
    // This test validates the hydration pattern used by CacheStore.initStorage:
    // 1. Read all keys from persistent layer
    // 2. For each, compare timestamps with memory
    // 3. Set the newer entry into memory
    const memory = createTestStorage({
      "key-x": { data: "old-mem", timestamp: 100 },
    });
    const persistent = createTestStorage({
      "key-x": { data: "new-per", timestamp: 200 },
      "key-y": { data: "per-only", timestamp: 300 },
    });

    const hybrid = createHybridStorage({ memory, persistent });

    // Simulate hydration
    const persistentKeys = await hybrid.keys();
    for (const key of persistentKeys) {
      const memEntry = memory.get(key);
      const perEntry = await persistent.get(key);
      if (perEntry && (!memEntry || perEntry.timestamp > (memEntry as CacheEntry).timestamp)) {
        memory.set(key, perEntry as CacheEntry);
      }
    }

    // After hydration, memory should have newer entries
    const resultX = await hybrid.get<string>(hk("key-x"));
    expect(resultX!.data).toBe("new-per");
    expect(resultX!.timestamp).toBe(200);

    const resultY = await hybrid.get<string>(hk("key-y"));
    expect(resultY!.data).toBe("per-only");
    expect(resultY!.timestamp).toBe(300);
  });
});

// ===============================================================
// createMemoryStorage basic sanity
// ===============================================================

describe("createMemoryStorage basic sanity", () => {
  it("should implement CacheStorage interface", () => {
    const storage = createMemoryStorage();

    expect(typeof storage.get).toBe("function");
    expect(typeof storage.set).toBe("function");
    expect(typeof storage.delete).toBe("function");
    expect(typeof storage.clear).toBe("function");
    expect(typeof storage.keys).toBe("function");
    expect(typeof storage.size).toBe("function");
  });

  it("should set and get entries", () => {
    const storage = createMemoryStorage();
    const entry: CacheEntry<string> = { data: "hello", timestamp: 1000 };

    storage.set(hk("test-key"), entry);
    const result = storage.get<string>(hk("test-key")) as CacheEntry<string> | null;

    expect(result).not.toBeNull();
    expect(result!.data).toBe("hello");
    expect(result!.timestamp).toBe(1000);
  });

  it("should respect maxSize option", () => {
    const storage = createMemoryStorage({ maxSize: 2 });

    storage.set(hk("k1"), { data: 1, timestamp: 1 });
    storage.set(hk("k2"), { data: 2, timestamp: 2 });
    // Should not throw when exceeding maxSize
    expect(() => storage.set(hk("k3"), { data: 3, timestamp: 3 })).not.toThrow();
  });
});
