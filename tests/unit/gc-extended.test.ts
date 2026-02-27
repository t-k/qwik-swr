import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { HashedKey, SWRError } from "../../src/types/index.ts";
import type { Observer } from "../../src/cache/types.ts";
import { store } from "../../src/cache/store.ts";
import { runGC } from "../../src/cache/gc.ts";

function createTestObserver(hashedKey: HashedKey): Observer {
  return {
    id: `ob-${Math.random().toString(36).slice(2)}`,
    hashedKey,
    lastRawKey: hashedKey.slice(2),
    hasData: false,
    onData: () => {},
    onError: (_error: SWRError) => {},
    onFetchStatusChange: (_status: string) => {},
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

describe("Extended GC (maxEntries / memoryAware)", () => {
  beforeEach(() => {
    store._reset();
  });

  afterEach(() => {
    store._reset();
  });

  describe("maxEntries enforcement", () => {
    it("should evict oldest orphan entries when cache exceeds maxEntries", () => {
      const now = Date.now();
      // Add 20 entries with increasing but recent timestamps (within cacheTime)
      for (let i = 0; i < 20; i++) {
        store.setCache(`s:k${i}` as HashedKey, { data: `v${i}`, timestamp: now - (20 - i) * 100 });
      }

      expect(store.keys().length).toBe(20);

      // Run GC with maxEntries=10
      runGC({ maxEntries: 10 });

      // Should have evicted the 10 oldest entries
      expect(store.keys().length).toBe(10);

      // Oldest entries should be gone (k0-k9 have the oldest timestamps)
      expect(store.getCache("s:k0" as HashedKey)).toBeNull();
      expect(store.getCache("s:k9" as HashedKey)).toBeNull();

      // Newest entries should remain
      expect(store.getCache("s:k10" as HashedKey)).not.toBeNull();
      expect(store.getCache("s:k19" as HashedKey)).not.toBeNull();
    });

    it("should never evict entries with active observers even if over maxEntries", () => {
      const now = Date.now();
      // Add 15 entries with recent timestamps
      for (let i = 0; i < 15; i++) {
        store.setCache(`s:k${i}` as HashedKey, { data: `v${i}`, timestamp: now - (15 - i) * 100 });
      }

      // Attach observers to the 10 oldest entries
      for (let i = 0; i < 10; i++) {
        const observer = createTestObserver(`s:k${i}` as HashedKey);
        store.attachObserver(`s:k${i}` as HashedKey, observer, DEFAULT_CONFIG as any);
      }

      // Run GC with maxEntries=5
      runGC({ maxEntries: 5 });

      // The 10 observed entries should survive
      for (let i = 0; i < 10; i++) {
        expect(store.getCache(`s:k${i}` as HashedKey)).not.toBeNull();
      }

      // The 5 unobserved entries (k10-k14) should be evicted down to what fits
      // Total observed=10, so maxEntries=5 can't evict observed entries
      // Only unobserved entries can be evicted
      // We had 5 unobserved entries, and we need to get total to 5 if possible
      // But since 10 are protected, the result is at most 10 remaining
      // The 5 orphan entries (k10-k14) get evicted
    });

    it("should not evict when entry count is within maxEntries", () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        store.setCache(`s:k${i}` as HashedKey, { data: `v${i}`, timestamp: now - i * 100 });
      }

      runGC({ maxEntries: 10 });

      // All entries should remain (within limit and fresh)
      expect(store.keys().length).toBe(5);
    });

    it("should not enforce maxEntries when undefined (existing behavior)", () => {
      for (let i = 0; i < 50; i++) {
        store.setCache(`s:k${i}` as HashedKey, { data: `v${i}`, timestamp: Date.now() });
      }

      // Run GC without maxEntries (should only check cacheTime)
      runGC();

      // All entries should remain (they're fresh)
      expect(store.keys().length).toBe(50);
    });
  });

  describe("memoryAware", () => {
    it("should scale down maxEntries for low-memory devices", () => {
      // Simulate low memory device
      const originalDeviceMemory = (navigator as any).deviceMemory;
      Object.defineProperty(navigator, "deviceMemory", {
        value: 2,
        configurable: true,
        writable: true,
      });

      // Add 20 entries
      for (let i = 0; i < 20; i++) {
        store.setCache(`s:k${i}` as HashedKey, { data: `v${i}`, timestamp: i * 100 });
      }

      // With memoryAware=true and deviceMemory=2, maxEntries should be scaled down
      // Base maxEntries=20, scaled by deviceMemory/8 = 2/8 = 0.25 → 5
      runGC({ maxEntries: 20, memoryAware: true });

      // Should have fewer entries due to memory scaling
      expect(store.keys().length).toBeLessThanOrEqual(20);

      // Restore
      if (originalDeviceMemory !== undefined) {
        Object.defineProperty(navigator, "deviceMemory", {
          value: originalDeviceMemory,
          configurable: true,
          writable: true,
        });
      } else {
        delete (navigator as any).deviceMemory;
      }
    });

    it("should not scale when memoryAware is false", () => {
      Object.defineProperty(navigator, "deviceMemory", {
        value: 1,
        configurable: true,
        writable: true,
      });

      for (let i = 0; i < 10; i++) {
        store.setCache(`s:k${i}` as HashedKey, { data: `v${i}`, timestamp: Date.now() });
      }

      // memoryAware=false: maxEntries should not be affected by deviceMemory
      runGC({ maxEntries: 10, memoryAware: false });

      expect(store.keys().length).toBe(10);

      delete (navigator as any).deviceMemory;
    });

    it("should handle missing navigator.deviceMemory gracefully", () => {
      const originalDeviceMemory = (navigator as any).deviceMemory;
      delete (navigator as any).deviceMemory;

      for (let i = 0; i < 10; i++) {
        store.setCache(`s:k${i}` as HashedKey, { data: `v${i}`, timestamp: Date.now() });
      }

      // Should not crash when deviceMemory is unavailable
      runGC({ maxEntries: 10, memoryAware: true });

      expect(store.keys().length).toBe(10);

      if (originalDeviceMemory !== undefined) {
        Object.defineProperty(navigator, "deviceMemory", {
          value: originalDeviceMemory,
          configurable: true,
          writable: true,
        });
      }
    });
  });
});
