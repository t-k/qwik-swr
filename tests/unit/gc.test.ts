import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { store } from "../../src/cache/store.ts";
import { hashKey } from "../../src/utils/hash.ts";
import { startGC, stopGC, runGC } from "../../src/cache/gc.ts";
import type { Observer } from "../../src/cache/types.ts";
import type { HashedKey, ResolvedSWROptions } from "../../src/types/index.ts";

// Helper to create a minimal observer
function createObserver(id: string, hashedKey: HashedKey): Observer {
  return {
    id,
    hashedKey,
    lastRawKey: "test-key",
    hasData: false,
    onData: () => {},
    onError: () => {},
    onFetchStatusChange: () => {},
  };
}

// Helper to create default resolved options
function createOpts(overrides: Partial<ResolvedSWROptions> = {}): ResolvedSWROptions {
  return {
    enabled: true,
    eagerness: "load",
    staleTime: 0,
    cacheTime: 5000,
    revalidateOn: [],
    refreshInterval: 0,
    dedupingInterval: 2000,
    retry: 0,
    retryInterval: 1000,
    timeout: 0,
    ...overrides,
  } as ResolvedSWROptions;
}

describe("GC (Garbage Collection)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store._reset();
    stopGC();
  });

  afterEach(() => {
    stopGC();
    store._reset();
    vi.useRealTimers();
  });

  // ─── T061: Entry with no observers + cacheTime expired -> deleted by GC ───
  describe("T061: expired entry with no observers is deleted", () => {
    it("should delete cache entry when observerCount=0 and age > cacheTime", () => {
      const key = "gc-test-1";
      const hashedKey = hashKey(key);

      // 1. Attach observer to set queryConfig (cacheTime: 5000ms)
      const observer = createObserver("ob-1", hashedKey);
      const opts = createOpts({ cacheTime: 5000 });
      store.attachObserver(hashedKey, observer, opts);

      // 2. Detach observer -> observerCount = 0, but queryConfig remains
      store.detachObserver(hashedKey, observer);
      expect(store.getObserverCount(hashedKey)).toBe(0);

      // 3. Set cache entry with old timestamp (10 seconds ago)
      const oldTimestamp = Date.now() - 10000;
      store.setCache(hashedKey, { data: "old-data", timestamp: oldTimestamp });

      // 4. Verify entry exists
      expect(store.getCache(hashedKey)).not.toBeNull();

      // 5. Run GC -> entry should be deleted (age 10000 > cacheTime 5000)
      runGC();

      // 6. Entry should be gone
      expect(store.getCache(hashedKey)).toBeNull();
    });

    it("should NOT delete cache entry when age <= cacheTime", () => {
      const key = "gc-test-fresh";
      const hashedKey = hashKey(key);

      const observer = createObserver("ob-fresh", hashedKey);
      const opts = createOpts({ cacheTime: 5000 });
      store.attachObserver(hashedKey, observer, opts);
      store.detachObserver(hashedKey, observer);

      // Set cache entry with recent timestamp (1 second ago)
      const recentTimestamp = Date.now() - 1000;
      store.setCache(hashedKey, { data: "fresh-data", timestamp: recentTimestamp });

      runGC();

      // Entry should still exist (age 1000 < cacheTime 5000)
      expect(store.getCache(hashedKey)).not.toBeNull();
      expect(store.getCache(hashedKey)!.data).toBe("fresh-data");
    });
  });

  // ─── T062: Entry with observers -> NOT deleted even if expired ───
  describe("T062: entry with observers is NOT deleted even if expired", () => {
    it("should NOT delete cache entry when observers are still attached", () => {
      const key = "gc-test-2";
      const hashedKey = hashKey(key);

      // 1. Attach observer (keep attached)
      const observer = createObserver("ob-2", hashedKey);
      const opts = createOpts({ cacheTime: 5000 });
      store.attachObserver(hashedKey, observer, opts);
      expect(store.getObserverCount(hashedKey)).toBe(1);

      // 2. Set cache entry with old timestamp
      const oldTimestamp = Date.now() - 10000;
      store.setCache(hashedKey, { data: "observed-data", timestamp: oldTimestamp });

      // 3. Run GC -> entry should NOT be deleted (has observers)
      runGC();

      // 4. Entry should still exist
      expect(store.getCache(hashedKey)).not.toBeNull();
      expect(store.getCache(hashedKey)!.data).toBe("observed-data");
    });
  });

  // ─── T063: GC interval is configurable ───
  describe("T063: GC interval is configurable", () => {
    it("should run GC at the configured interval", () => {
      const key = "gc-interval-test";
      const hashedKey = hashKey(key);

      // Set up an expired entry with no observers
      const observer = createObserver("ob-3", hashedKey);
      const opts = createOpts({ cacheTime: 100 });
      store.attachObserver(hashedKey, observer, opts);
      store.detachObserver(hashedKey, observer);

      const oldTimestamp = Date.now() - 500;
      store.setCache(hashedKey, { data: "interval-data", timestamp: oldTimestamp });

      // Start GC with custom interval of 500ms
      startGC({ intervalMs: 500 });

      // Entry should still exist before interval fires
      expect(store.getCache(hashedKey)).not.toBeNull();

      // Advance time by 500ms -> GC should run
      vi.advanceTimersByTime(500);

      // Entry should be deleted
      expect(store.getCache(hashedKey)).toBeNull();
    });

    it("should use default interval (60000ms) when not configured", () => {
      const key = "gc-default-interval";
      const hashedKey = hashKey(key);

      const observer = createObserver("ob-default", hashedKey);
      const opts = createOpts({ cacheTime: 100 });
      store.attachObserver(hashedKey, observer, opts);
      store.detachObserver(hashedKey, observer);

      const oldTimestamp = Date.now() - 500;
      store.setCache(hashedKey, { data: "default-interval-data", timestamp: oldTimestamp });

      startGC();

      // Advance by 59 seconds -> GC should NOT have run yet
      vi.advanceTimersByTime(59000);
      expect(store.getCache(hashedKey)).not.toBeNull();

      // Advance by 1 more second (total 60s) -> GC should run
      vi.advanceTimersByTime(1000);
      expect(store.getCache(hashedKey)).toBeNull();
    });
  });

  // ─── T064: SSR environment -> GC timer should NOT start ───
  describe("T064: GC does not start in SSR environment", () => {
    it("should NOT start GC timer when window is undefined", () => {
      const originalWindow = globalThis.window;
      // @ts-ignore - simulate SSR by removing window
      delete (globalThis as any).window;

      try {
        startGC({ intervalMs: 100 });

        // Set up an expired entry
        const key = "gc-ssr-test";
        const hashedKey = hashKey(key);

        const observer = createObserver("ob-ssr", hashedKey);
        const opts = createOpts({ cacheTime: 50 });
        store.attachObserver(hashedKey, observer, opts);
        store.detachObserver(hashedKey, observer);

        store.setCache(hashedKey, { data: "ssr-data", timestamp: Date.now() - 1000 });

        // Advance timer -> GC should NOT run (no timer was started)
        vi.advanceTimersByTime(500);

        // Entry should still exist because GC never started
        expect(store.getCache(hashedKey)).not.toBeNull();
        expect(store.getCache(hashedKey)!.data).toBe("ssr-data");
      } finally {
        // Restore window
        if (originalWindow !== undefined) {
          globalThis.window = originalWindow;
        }
      }
    });

    it("should NOT start GC timer when enabled is false", () => {
      startGC({ enabled: false, intervalMs: 100 });

      const key = "gc-disabled-test";
      const hashedKey = hashKey(key);

      const observer = createObserver("ob-disabled", hashedKey);
      const opts = createOpts({ cacheTime: 50 });
      store.attachObserver(hashedKey, observer, opts);
      store.detachObserver(hashedKey, observer);

      store.setCache(hashedKey, { data: "disabled-data", timestamp: Date.now() - 1000 });

      vi.advanceTimersByTime(500);

      // Entry should still exist because GC was disabled
      expect(store.getCache(hashedKey)).not.toBeNull();
      expect(store.getCache(hashedKey)!.data).toBe("disabled-data");
    });

    it("should stop existing GC timer when re-initialized with enabled: false", () => {
      const key = "gc-reinit-disable";
      const hashedKey = hashKey(key);

      const observer = createObserver("ob-reinit", hashedKey);
      const opts = createOpts({ cacheTime: 50 });
      store.attachObserver(hashedKey, observer, opts);
      store.detachObserver(hashedKey, observer);

      store.setCache(hashedKey, { data: "will-be-gc'd", timestamp: Date.now() - 1000 });

      // Start GC with 500ms interval (enabled by default)
      startGC({ intervalMs: 500 });

      // Re-initialize with enabled: false -> must stop the running timer
      startGC({ enabled: false });

      // Advance past the original interval
      vi.advanceTimersByTime(1000);

      // Entry should still exist because GC was stopped
      expect(store.getCache(hashedKey)).not.toBeNull();
      expect(store.getCache(hashedKey)!.data).toBe("will-be-gc'd");
    });
  });
});
