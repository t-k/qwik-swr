import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { store } from "../../src/cache/store.ts";
import { cache } from "../../src/cache/cache-api.ts";
import { hashKey } from "../../src/utils/hash.ts";
import type { HashedKey, ValidKey, RevalidateTrigger } from "../../src/types/index.ts";
import type { Observer } from "../../src/cache/types.ts";

function createMockObserver(hashedKey: HashedKey, rawKey: ValidKey): Observer {
  return {
    id: crypto.randomUUID(),
    hashedKey,
    lastRawKey: rawKey,
    hasData: false,
    onData: vi.fn(),
    onError: vi.fn(),
    onFetchStatusChange: vi.fn(),
  };
}

function minOpts() {
  return {
    enabled: true,
    eagerness: "load" as const,
    staleTime: 30_000,
    cacheTime: 300_000,
    dedupingInterval: 5_000,
    revalidateOn: [] as RevalidateTrigger[],
    refreshInterval: 0,
    retry: 0,
    retryInterval: 1000,
    timeout: 30_000,
  };
}

describe("mutation-cache integration", () => {
  beforeEach(() => {
    store._reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // T012: Optimistic update immediately updates cache
  describe("optimistic update", () => {
    it("should immediately update cache with optimistic data", () => {
      const key = "/api/todos";
      const hashed = hashKey(key);
      const originalData = [{ id: 1, title: "existing" }];

      // Set up initial cache entry
      store.setCache(hashed, { data: originalData, timestamp: Date.now() });

      // Simulate optimistic update: save snapshot, then write optimistic data
      const _snapshot = store.getCache(hashed);
      const optimisticData = [...originalData, { id: 999, title: "optimistic" }];
      store.setCache(hashed, { data: optimisticData, timestamp: Date.now() });

      // Verify cache was updated immediately
      expect(store.getCache(hashed)?.data).toEqual(optimisticData);
    });

    it("should notify observers when optimistic data is set", () => {
      const key = "/api/todos";
      const hashed = hashKey(key);
      const observer = createMockObserver(hashed, key);

      store.attachObserver(hashed, observer, minOpts());

      // Clear initial notification from attach
      (observer.onData as any).mockClear();

      // Optimistic update
      store.setCache(hashed, {
        data: [{ id: 1, title: "optimistic" }],
        timestamp: Date.now(),
      });

      expect(observer.onData).toHaveBeenCalledOnce();
    });
  });

  // T013: Error rollback restores original cache
  describe("error rollback", () => {
    it("should restore original cache entry on mutation error", () => {
      const key = "/api/todos";
      const hashed = hashKey(key);
      const originalData = [{ id: 1, title: "original" }];

      // Set up original cache
      store.setCache(hashed, { data: originalData, timestamp: Date.now() });

      // Save snapshot (before optimistic update)
      const snapshot = store.getCache(hashed)!;

      // Apply optimistic update
      store.setCache(hashed, {
        data: [...originalData, { id: 999, title: "temp" }],
        timestamp: Date.now(),
      });

      // Simulate error → rollback from snapshot
      store.setCache(hashed, snapshot);

      expect(store.getCache(hashed)?.data).toEqual(originalData);
    });

    it("should rollback to null when no original data existed", () => {
      const key = "/api/todos";
      const hashed = hashKey(key);

      // No initial cache
      const snapshot = store.getCache(hashed); // null

      // Apply optimistic update
      store.setCache(hashed, {
        data: [{ id: 999 }],
        timestamp: Date.now(),
      });

      // Rollback: delete the cache since there was no original
      if (snapshot === null) {
        store.deleteCache(hashed);
      }

      expect(store.getCache(hashed)).toBeNull();
    });
  });

  // T014: invalidateKeys triggers cache.revalidate
  describe("invalidateKeys", () => {
    it("should trigger revalidation for specified keys after mutation success", () => {
      const key1 = "/api/todos";
      const key2 = "/api/stats";
      const hashed1 = hashKey(key1);
      const hashed2 = hashKey(key2);

      // Set up observers with fetchers (needed for revalidation)
      const observer1 = createMockObserver(hashed1, key1);
      const observer2 = createMockObserver(hashed2, key2);

      store.attachObserver(hashed1, observer1, minOpts());
      store.attachObserver(hashed2, observer2, minOpts());

      // Register fetchers via ensureFetch
      const fetcher1 = vi.fn().mockResolvedValue([{ id: 1 }]);
      const fetcher2 = vi.fn().mockResolvedValue({ count: 5 });

      store.ensureFetch(hashed1, key1, fetcher1);
      store.ensureFetch(hashed2, key2, fetcher2);

      // Clear fetcher calls
      fetcher1.mockClear();
      fetcher2.mockClear();

      // Wait for first fetch to complete
      vi.advanceTimersByTime(100);

      // Simulate invalidateKeys: revalidate both keys
      cache.revalidate(key1);
      cache.revalidate(key2);

      // Both keys should have had forceRevalidate called
      expect(fetcher1).toHaveBeenCalled();
      expect(fetcher2).toHaveBeenCalled();
    });
  });

  // T015: Concurrent mutations with last-write-wins
  describe("concurrent mutation (last-write-wins)", () => {
    it("should have the last setCache call win when concurrent mutations write", async () => {
      const key = "/api/todos";
      const hashed = hashKey(key);
      const observer = createMockObserver(hashed, key);
      store.attachObserver(hashed, observer, minOpts());

      // Simulate two concurrent mutations
      // Mutation A: slow
      const mutationA = async () => {
        await new Promise((r) => setTimeout(r, 100));
        store.setCache(hashed, { data: "A-result", timestamp: Date.now() });
      };

      // Mutation B: fast (completes first)
      const mutationB = async () => {
        await new Promise((r) => setTimeout(r, 50));
        store.setCache(hashed, { data: "B-result", timestamp: Date.now() });
      };

      const pA = mutationA();
      const pB = mutationB();

      // B completes first
      vi.advanceTimersByTime(50);
      await pB;
      expect(store.getCache(hashed)?.data).toBe("B-result");

      // A completes second (last-write-wins)
      vi.advanceTimersByTime(50);
      await pA;
      expect(store.getCache(hashed)?.data).toBe("A-result");
    });
  });
});
