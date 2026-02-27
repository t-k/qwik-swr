import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createIndexedDBStorage } from "../../storage/indexed-db.ts";
import type { CacheEntry, HashedKey } from "../../src/types/index.ts";

// Helper to cast string to HashedKey in tests
const hk = (s: string) => s as HashedKey;

// Each test gets a unique DB name to prevent state leaking between tests
let dbCounter = 0;
function uniqueStorage() {
  return createIndexedDBStorage({ dbName: `test-db-${++dbCounter}` });
}

// ===============================================================
// Setup / Teardown
// ===============================================================

afterEach(() => {
  vi.restoreAllMocks();
});

// ===============================================================
// T036: IndexedDB async set/get roundtrip
// ===============================================================

describe("T036: IndexedDB async set/get roundtrip", () => {
  it("should return a CacheStorage-compatible object", () => {
    const storage = uniqueStorage();

    expect(storage).toBeDefined();
    expect(typeof storage.get).toBe("function");
    expect(typeof storage.set).toBe("function");
    expect(typeof storage.delete).toBe("function");
    expect(typeof storage.clear).toBe("function");
    expect(typeof storage.keys).toBe("function");
    expect(typeof storage.size).toBe("function");
  });

  it("should store and retrieve a CacheEntry asynchronously", async () => {
    const storage = uniqueStorage();
    const key = hk("s:/api/users");
    const entry: CacheEntry<string> = {
      data: "indexed-data",
      timestamp: 5000,
    };

    await storage.set(key, entry);
    const result = await storage.get<string>(key);

    expect(result).not.toBeNull();
    expect(result!.data).toBe("indexed-data");
    expect(result!.timestamp).toBe(5000);
  });

  it("should return null for non-existent key", async () => {
    const storage = uniqueStorage();
    const result = await storage.get(hk("non-existent"));

    expect(result).toBeNull();
  });

  it("should support async delete", async () => {
    const storage = uniqueStorage();
    const key = hk("s:/api/delete-me");
    await storage.set(key, { data: "temp", timestamp: 1000 });

    await storage.delete(key);
    const result = await storage.get(key);

    expect(result).toBeNull();
  });

  it("should support async clear", async () => {
    const storage = uniqueStorage();
    await storage.set(hk("k1"), { data: "a", timestamp: 1 });
    await storage.set(hk("k2"), { data: "b", timestamp: 2 });

    await storage.clear();

    expect(await storage.get(hk("k1"))).toBeNull();
    expect(await storage.get(hk("k2"))).toBeNull();
    expect(await storage.size()).toBe(0);
  });

  it("should support async keys", async () => {
    const storage = uniqueStorage();
    await storage.set(hk("key-x"), { data: "x", timestamp: 1 });
    await storage.set(hk("key-y"), { data: "y", timestamp: 2 });

    const keys = await storage.keys();

    expect(keys).toContain("key-x");
    expect(keys).toContain("key-y");
    expect(keys).toHaveLength(2);
  });

  it("should support async size", async () => {
    const storage = uniqueStorage();
    expect(await storage.size()).toBe(0);

    await storage.set(hk("k1"), { data: 1, timestamp: 1 });
    expect(await storage.size()).toBe(1);
  });

  it("should handle complex data via structured clone", async () => {
    const storage = uniqueStorage();
    const key = hk("s:/api/complex");
    const entry: CacheEntry<{ items: number[]; nested: { ok: boolean } }> = {
      data: { items: [1, 2, 3], nested: { ok: true } },
      timestamp: 3000,
    };

    await storage.set(key, entry);
    const result = await storage.get<{ items: number[]; nested: { ok: boolean } }>(key);

    expect(result).not.toBeNull();
    expect(result!.data!.items).toEqual([1, 2, 3]);
    expect(result!.data!.nested.ok).toBe(true);
  });
});

// ===============================================================
// SSR no-op behavior
// ===============================================================

describe("IndexedDB SSR no-op behavior", () => {
  it("should return no-op when window is undefined", async () => {
    const originalWindow = globalThis.window;
    vi.stubGlobal("window", undefined);

    const storage = createIndexedDBStorage();

    // All async methods should resolve to no-op values
    expect(await storage.get(hk("key"))).toBeNull();
    await expect(storage.set(hk("key"), { data: "x", timestamp: 1 })).resolves.toBeUndefined();
    await expect(storage.delete(hk("key"))).resolves.toBeUndefined();
    await expect(storage.clear()).resolves.toBeUndefined();
    expect(await storage.keys()).toEqual([]);
    expect(await storage.size()).toBe(0);

    vi.stubGlobal("window", originalWindow);
  });
});
