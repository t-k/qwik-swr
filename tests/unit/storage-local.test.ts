import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createLocalStorage } from "../../storage/local-storage.ts";
import type { CacheEntry, HashedKey, SWRError } from "../../src/types/index.ts";

// Helper to cast string to HashedKey in tests
const hk = (s: string) => s as HashedKey;

// ===============================================================
// Mock localStorage
// ===============================================================

let mockStorage: Map<string, string>;

function setupMockLocalStorage(): void {
  mockStorage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mockStorage.get(k) ?? null,
    setItem: (k: string, v: string) => mockStorage.set(k, v),
    removeItem: (k: string) => mockStorage.delete(k),
    clear: () => mockStorage.clear(),
    get length() {
      return mockStorage.size;
    },
    key: (i: number) => [...mockStorage.keys()][i] ?? null,
  });
}

// ===============================================================
// Setup / Teardown
// ===============================================================

beforeEach(() => {
  setupMockLocalStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===============================================================
// T034: localStorage set/get roundtrip
// ===============================================================

describe("T034: localStorage set/get roundtrip", () => {
  it("should store and retrieve a CacheEntry via set/get", () => {
    const storage = createLocalStorage();
    const key = hk("s:/api/users");
    const entry: CacheEntry<string> = {
      data: "hello world",
      timestamp: 1000,
    };

    storage.set(key, entry);
    const result = storage.get<string>(key) as CacheEntry<string> | null;

    expect(result).not.toBeNull();
    expect(result!.data).toBe("hello world");
    expect(result!.timestamp).toBe(1000);
  });

  it("should return null for non-existent key", () => {
    const storage = createLocalStorage();
    const result = storage.get(hk("non-existent-key"));
    expect(result).toBeNull();
  });

  it("should handle complex data types (objects, arrays, nested)", () => {
    const storage = createLocalStorage();
    const key = hk("s:/api/complex");
    const entry: CacheEntry<{ users: Array<{ id: number; name: string }> }> = {
      data: {
        users: [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
        ],
      },
      timestamp: 2000,
    };

    storage.set(key, entry);
    const result = storage.get<{ users: Array<{ id: number; name: string }> }>(key) as CacheEntry<{
      users: Array<{ id: number; name: string }>;
    }> | null;

    expect(result).not.toBeNull();
    expect(result!.data!.users).toHaveLength(2);
    expect(result!.data!.users[0].name).toBe("Alice");
  });

  it("should support delete operation", () => {
    const storage = createLocalStorage();
    const key = hk("s:/api/delete-me");
    const entry: CacheEntry<string> = { data: "temp", timestamp: 3000 };

    storage.set(key, entry);
    expect(storage.get(key)).not.toBeNull();

    storage.delete(key);
    expect(storage.get(key)).toBeNull();
  });

  it("should support clear operation", () => {
    const storage = createLocalStorage();
    storage.set(hk("key1"), { data: "a", timestamp: 1 });
    storage.set(hk("key2"), { data: "b", timestamp: 2 });

    expect(storage.size()).toBe(2);

    storage.clear();

    expect(storage.size()).toBe(0);
    expect(storage.get(hk("key1"))).toBeNull();
    expect(storage.get(hk("key2"))).toBeNull();
  });

  it("should support keys operation", () => {
    const storage = createLocalStorage();
    storage.set(hk("key-a"), { data: "a", timestamp: 1 });
    storage.set(hk("key-b"), { data: "b", timestamp: 2 });

    const keys = storage.keys();
    expect(keys).toContain("key-a");
    expect(keys).toContain("key-b");
    expect(keys).toHaveLength(2);
  });

  it("should support size operation", () => {
    const storage = createLocalStorage();
    expect(storage.size()).toBe(0);

    storage.set(hk("k1"), { data: 1, timestamp: 1 });
    expect(storage.size()).toBe(1);

    storage.set(hk("k2"), { data: 2, timestamp: 2 });
    expect(storage.size()).toBe(2);
  });

  it("should handle CacheEntry with error field", () => {
    const storage = createLocalStorage();
    const key = hk("s:/api/with-error");
    const entry: CacheEntry<null> = {
      data: null,
      timestamp: 5000,
      error: {
        type: "network",
        message: "Failed to fetch",
        retryCount: 2,
        timestamp: 4999,
      },
    };

    storage.set(key, entry);
    const result = storage.get<null>(key) as CacheEntry<null> | null;

    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
    expect(result!.error!.type).toBe("network");
    expect(result!.error!.message).toBe("Failed to fetch");
    expect(result!.error!.retryCount).toBe(2);
  });
});

// ===============================================================
// T035: localStorage prefix key
// ===============================================================

describe("T035: localStorage prefix key", () => {
  it("should use default prefix 'swr:' when storing keys", () => {
    const storage = createLocalStorage();
    const key = hk("s:/api/users");
    const entry: CacheEntry<string> = { data: "test", timestamp: 1000 };

    storage.set(key, entry);

    // Verify the actual localStorage key includes the prefix
    expect(mockStorage.has("swr:s:/api/users")).toBe(true);
    expect(mockStorage.has("s:/api/users")).toBe(false);
  });

  it("should use custom prefix when provided", () => {
    const storage = createLocalStorage({ prefix: "myapp:" });
    const key = hk("s:/api/users");
    const entry: CacheEntry<string> = { data: "test", timestamp: 1000 };

    storage.set(key, entry);

    expect(mockStorage.has("myapp:s:/api/users")).toBe(true);
    expect(mockStorage.has("swr:s:/api/users")).toBe(false);
  });

  it("should correctly retrieve keys with prefix via get", () => {
    const storage = createLocalStorage({ prefix: "custom:" });
    const key = hk("my-key");
    const entry: CacheEntry<number> = { data: 42, timestamp: 2000 };

    storage.set(key, entry);
    const result = storage.get<number>(key) as CacheEntry<number> | null;

    expect(result).not.toBeNull();
    expect(result!.data).toBe(42);
  });

  it("should only return unprefixed keys from keys()", () => {
    const storage = createLocalStorage({ prefix: "test:" });
    storage.set(hk("key1"), { data: "a", timestamp: 1 });
    storage.set(hk("key2"), { data: "b", timestamp: 2 });

    const keys = storage.keys();
    expect(keys).toContain("key1");
    expect(keys).toContain("key2");
    // Keys should not include the prefix
    expect((keys as string[]).every((k: string) => !k.startsWith("test:"))).toBe(true);
  });

  it("should delete using prefixed key", () => {
    const storage = createLocalStorage({ prefix: "del:" });
    const key = hk("to-remove");
    storage.set(key, { data: "x", timestamp: 1 });

    expect(mockStorage.has("del:to-remove")).toBe(true);

    storage.delete(key);

    expect(mockStorage.has("del:to-remove")).toBe(false);
  });

  it("should only clear entries with matching prefix", () => {
    const storage = createLocalStorage({ prefix: "app:" });
    storage.set(hk("key1"), { data: "a", timestamp: 1 });
    storage.set(hk("key2"), { data: "b", timestamp: 2 });

    // Simulate another app's data in localStorage
    mockStorage.set("other:data", "unrelated");

    storage.clear();

    // Our entries should be gone
    expect(mockStorage.has("app:key1")).toBe(false);
    expect(mockStorage.has("app:key2")).toBe(false);
    // Other app's data should remain
    expect(mockStorage.has("other:data")).toBe(true);
  });

  it("should return correct size counting only prefixed entries", () => {
    const storage = createLocalStorage({ prefix: "sized:" });
    storage.set(hk("a"), { data: 1, timestamp: 1 });
    storage.set(hk("b"), { data: 2, timestamp: 2 });

    // Add unrelated entry
    mockStorage.set("unrelated", "value");

    expect(storage.size()).toBe(2);
  });
});

// ===============================================================
// T039: Capacity overflow should not throw
// ===============================================================

describe("T039: capacity overflow should not throw", () => {
  it("should not throw when localStorage.setItem throws QuotaExceededError", () => {
    // Override setItem to throw
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mockStorage.get(k) ?? null,
      setItem: () => {
        throw new DOMException("QuotaExceededError", "QuotaExceededError");
      },
      removeItem: (k: string) => mockStorage.delete(k),
      clear: () => mockStorage.clear(),
      get length() {
        return mockStorage.size;
      },
      key: (i: number) => [...mockStorage.keys()][i] ?? null,
    });

    const storage = createLocalStorage();
    const entry: CacheEntry<string> = { data: "overflow", timestamp: 1000 };

    // Should not throw
    expect(() => storage.set(hk("overflow-key"), entry)).not.toThrow();
  });

  it("should not throw when maxSize is exceeded", () => {
    const storage = createLocalStorage({ maxSize: 2 });

    storage.set(hk("k1"), { data: "a", timestamp: 1 });
    storage.set(hk("k2"), { data: "b", timestamp: 2 });

    // Third entry exceeds maxSize -- should not throw
    expect(() => storage.set(hk("k3"), { data: "c", timestamp: 3 })).not.toThrow();
  });
});

// ===============================================================
// T040: SSR environment (no window) should return no-op
// ===============================================================

describe("T040: SSR environment should return no-op behavior", () => {
  it("should return a CacheStorage-compatible no-op when window is undefined", () => {
    // Temporarily remove window to simulate SSR
    const originalWindow = globalThis.window;
    vi.stubGlobal("window", undefined);

    const storage = createLocalStorage();

    // All operations should be no-op and not throw
    expect(() => storage.set(hk("key"), { data: "x", timestamp: 1 })).not.toThrow();
    expect(storage.get(hk("key"))).toBeNull();
    expect(() => storage.delete(hk("key"))).not.toThrow();
    expect(() => storage.clear()).not.toThrow();
    expect(storage.keys()).toEqual([]);
    expect(storage.size()).toBe(0);

    // Restore window
    vi.stubGlobal("window", originalWindow);
  });
});

// ===============================================================
// GAP-ST1: toStorable strips error.original
// ===============================================================

describe("toStorable strips error.original", () => {
  it("should strip error.original when storing entries with errors", () => {
    const storage = createLocalStorage();
    const error: SWRError = {
      type: "network",
      message: "fail",
      retryCount: 0,
      timestamp: 1000,
      original: new Error("raw error"), // non-serializable
    };
    const entry: CacheEntry<null> & { error: SWRError } = {
      data: null,
      timestamp: 1000,
      error,
    };

    storage.set(hk("err-key"), entry as CacheEntry<null>);
    const result = storage.get(hk("err-key")) as CacheEntry | null;

    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
    expect(result!.error!.type).toBe("network");
    expect((result!.error as any).original).toBeUndefined();
  });
});
