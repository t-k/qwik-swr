import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CacheEntry, CacheStorage, HashedKey } from "../../src/types/index.ts";

/** In-memory storage for testing (not a mock — a real object) */
function createTestStorage(): CacheStorage & {
  setCalls: Array<{ key: HashedKey; entry: CacheEntry }>;
  deleteCalls: HashedKey[];
  clearCalls: number;
  _store: Map<HashedKey, CacheEntry>;
} {
  const _store = new Map<HashedKey, CacheEntry>();
  const setCalls: Array<{ key: HashedKey; entry: CacheEntry }> = [];
  const deleteCalls: HashedKey[] = [];
  let clearCalls = 0;

  return {
    _store,
    setCalls,
    deleteCalls,
    get clearCalls() {
      return clearCalls;
    },
    get(key: HashedKey) {
      return _store.get(key) ?? null;
    },
    set(key: HashedKey, entry: CacheEntry) {
      setCalls.push({ key, entry });
      _store.set(key, entry);
    },
    delete(key: HashedKey) {
      deleteCalls.push(key);
      _store.delete(key);
    },
    clear() {
      clearCalls++;
      _store.clear();
    },
    keys() {
      return [..._store.keys()];
    },
    size() {
      return _store.size;
    },
  };
}

describe("createBatchedStorage", () => {
  let createBatchedStorage: typeof import("../../storage/batched.ts").createBatchedStorage;

  beforeEach(async () => {
    vi.useFakeTimers();
    const mod = await import("../../storage/batched.ts");
    createBatchedStorage = mod.createBatchedStorage;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should batch multiple set calls into a single flush", () => {
    const base = createTestStorage();
    const batched = createBatchedStorage(base, { flushInterval: 50 });

    // Write 20 entries rapidly
    for (let i = 0; i < 20; i++) {
      batched.set(`s:key${i}` as HashedKey, { data: i, timestamp: i });
    }

    // Base storage should not have been called yet
    expect(base.setCalls).toHaveLength(0);

    // Advance timer to trigger flush
    vi.advanceTimersByTime(50);

    // All entries should now be in base storage
    expect(base._store.size).toBe(20);
    // But set was called only once per key in the flush (20 calls, not more)
    expect(base.setCalls).toHaveLength(20);

    batched.dispose();
  });

  it("should dedup same-key writes (latest wins)", () => {
    const base = createTestStorage();
    const batched = createBatchedStorage(base, { flushInterval: 50 });

    batched.set("s:key1" as HashedKey, { data: "v1", timestamp: 1 });
    batched.set("s:key1" as HashedKey, { data: "v2", timestamp: 2 });
    batched.set("s:key1" as HashedKey, { data: "v3", timestamp: 3 });

    vi.advanceTimersByTime(50);

    expect(base.setCalls).toHaveLength(1);
    expect(base.setCalls[0]!.entry.data).toBe("v3");

    batched.dispose();
  });

  it("should batch delete calls", () => {
    const base = createTestStorage();
    const batched = createBatchedStorage(base, { flushInterval: 50 });

    batched.delete("s:k1" as HashedKey);
    batched.delete("s:k2" as HashedKey);

    expect(base.deleteCalls).toHaveLength(0);

    vi.advanceTimersByTime(50);

    expect(base.deleteCalls).toHaveLength(2);

    batched.dispose();
  });

  it("should handle clear correctly (clear → deletes → writes order)", () => {
    const base = createTestStorage();
    // Pre-populate base storage
    base.set("s:old" as HashedKey, { data: "old", timestamp: 1 });

    const batched = createBatchedStorage(base, { flushInterval: 50 });

    // Clear, then add new data
    batched.clear();
    batched.set("s:new" as HashedKey, { data: "new", timestamp: 100 });

    vi.advanceTimersByTime(50);

    // Clear should have been called (1 from batched flush)
    expect(base.clearCalls).toBe(1);
    expect(base._store.has("s:old" as HashedKey)).toBe(false);
    expect(base._store.get("s:new" as HashedKey)?.data).toBe("new");

    batched.dispose();
  });

  it("should cancel pending writes for a key when delete is called", () => {
    const base = createTestStorage();
    const batched = createBatchedStorage(base, { flushInterval: 50 });

    batched.set("s:k1" as HashedKey, { data: "v1", timestamp: 1 });
    batched.delete("s:k1" as HashedKey);

    vi.advanceTimersByTime(50);

    // The set should have been cancelled by the delete
    expect(base.setCalls).toHaveLength(0);
    expect(base.deleteCalls).toHaveLength(1);

    batched.dispose();
  });

  it("should cancel pending deletes when set is called for same key", () => {
    const base = createTestStorage();
    const batched = createBatchedStorage(base, { flushInterval: 50 });

    batched.delete("s:k1" as HashedKey);
    batched.set("s:k1" as HashedKey, { data: "v1", timestamp: 1 });

    vi.advanceTimersByTime(50);

    // The delete should have been cancelled by the set
    expect(base.deleteCalls).toHaveLength(0);
    expect(base.setCalls).toHaveLength(1);

    batched.dispose();
  });

  it("should flush on dispose", () => {
    const base = createTestStorage();
    const batched = createBatchedStorage(base, { flushInterval: 50 });

    batched.set("s:k1" as HashedKey, { data: "v1", timestamp: 1 });

    // Without advancing timer, call dispose → should flush
    batched.dispose();

    expect(base.setCalls).toHaveLength(1);
  });

  it("should pass through get/keys/size to base storage", () => {
    const base = createTestStorage();
    base.set("s:k1" as HashedKey, { data: "v1", timestamp: 1 });
    base.set("s:k2" as HashedKey, { data: "v2", timestamp: 2 });

    const batched = createBatchedStorage(base, { flushInterval: 50 });

    expect(batched.get("s:k1" as HashedKey)).toEqual({ data: "v1", timestamp: 1 });
    expect(batched.keys()).toEqual(expect.arrayContaining(["s:k1", "s:k2"]));
    expect(batched.size()).toBe(2);

    batched.dispose();
  });

  it("keys() should reflect pending writes and deletes (MF-3)", () => {
    const base = createTestStorage();
    base.set("s:k1" as HashedKey, { data: "v1", timestamp: 1 });
    base.set("s:k2" as HashedKey, { data: "v2", timestamp: 2 });

    const batched = createBatchedStorage(base, { flushInterval: 50 });

    // Pending write adds a new key
    batched.set("s:k3" as HashedKey, { data: "v3", timestamp: 3 });
    const keys1 = batched.keys() as HashedKey[];
    expect(keys1).toContain("s:k3");
    expect(keys1).toHaveLength(3);

    // Pending delete removes a base key
    batched.delete("s:k1" as HashedKey);
    const keys2 = batched.keys() as HashedKey[];
    expect(keys2).not.toContain("s:k1");
    expect(keys2).toHaveLength(2);

    batched.dispose();
  });

  it("keys()/size() after clear should only show pending writes (MF-3)", () => {
    const base = createTestStorage();
    base.set("s:k1" as HashedKey, { data: "v1", timestamp: 1 });

    const batched = createBatchedStorage(base, { flushInterval: 50 });

    batched.clear();
    expect(batched.keys()).toEqual([]);
    expect(batched.size()).toBe(0);

    batched.set("s:new" as HashedKey, { data: "new", timestamp: 2 });
    expect(batched.keys()).toEqual(["s:new"]);
    expect(batched.size()).toBe(1);

    batched.dispose();
  });

  it("size() should match keys() length (MF-3)", () => {
    const base = createTestStorage();
    base.set("s:k1" as HashedKey, { data: "v1", timestamp: 1 });
    base.set("s:k2" as HashedKey, { data: "v2", timestamp: 2 });

    const batched = createBatchedStorage(base, { flushInterval: 50 });

    batched.set("s:k3" as HashedKey, { data: "v3", timestamp: 3 });
    batched.delete("s:k1" as HashedKey);

    const keys = batched.keys() as HashedKey[];
    expect(batched.size()).toBe(keys.length);

    batched.dispose();
  });

  it("should handle explicit flush() call", async () => {
    const base = createTestStorage();
    const batched = createBatchedStorage(base, { flushInterval: 50 });

    batched.set("s:k1" as HashedKey, { data: "v1", timestamp: 1 });

    // Explicit flush before timer
    await batched.flush();

    expect(base.setCalls).toHaveLength(1);

    batched.dispose();
  });

  it("should handle multiple flush cycles correctly", () => {
    const base = createTestStorage();
    const batched = createBatchedStorage(base, { flushInterval: 50 });

    // Cycle 1
    batched.set("s:k1" as HashedKey, { data: "v1", timestamp: 1 });
    vi.advanceTimersByTime(50);
    expect(base.setCalls).toHaveLength(1);

    // Cycle 2
    batched.set("s:k2" as HashedKey, { data: "v2", timestamp: 2 });
    vi.advanceTimersByTime(50);
    expect(base.setCalls).toHaveLength(2);

    batched.dispose();
  });
});
