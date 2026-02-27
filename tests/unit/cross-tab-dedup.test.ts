import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncMessage, CacheEntry, HashedKey, SWRError } from "../../src/types/index.ts";
import type { Observer } from "../../src/cache/types.ts";
import { store } from "../../src/cache/store.ts";

// Minimal BroadcastChannel stub
const channels: Map<
  string,
  Set<{ onmessage: ((event: { data: unknown }) => void) | null }>
> = new Map();

class FakeBroadcastChannel {
  name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    const set = channels.get(name) ?? new Set();
    set.add(this);
    channels.set(name, set);
  }

  postMessage(data: unknown): void {
    const set = channels.get(this.name);
    if (!set) return;
    for (const ch of set) {
      if (ch !== this && ch.onmessage) {
        ch.onmessage({ data: structuredClone(data) });
      }
    }
  }

  close(): void {
    const set = channels.get(this.name);
    if (set) {
      set.delete(this);
      if (set.size === 0) channels.delete(this.name);
    }
  }
}

function createTestObserver(hashedKey: HashedKey): Observer & {
  dataHistory: CacheEntry[];
  errorHistory: SWRError[];
  statusHistory: string[];
} {
  const dataHistory: CacheEntry[] = [];
  const errorHistory: SWRError[] = [];
  const statusHistory: string[] = [];
  return {
    id: `ob-${Math.random().toString(36).slice(2)}`,
    hashedKey,
    lastRawKey: hashedKey.slice(2),
    hasData: false,
    onData: (entry: CacheEntry) => dataHistory.push(entry),
    onError: (error: SWRError) => errorHistory.push(error),
    onFetchStatusChange: (status: string) => statusHistory.push(status),
    dataHistory,
    errorHistory,
    statusHistory,
  };
}

const DEFAULT_CONFIG = {
  enabled: true,
  eagerness: "visible" as const,
  staleTime: 0,
  cacheTime: 300_000,
  dedupingInterval: 2_000,
  revalidateOn: [] as string[],
  refreshInterval: 0,
  retry: 0,
  retryInterval: 1000,
  timeout: 30_000,
};

describe("Cross-tab fetch dedup", () => {
  beforeEach(() => {
    channels.clear();
    (globalThis as any).BroadcastChannel = FakeBroadcastChannel;
    store._reset();
  });

  afterEach(() => {
    store._reset();
    channels.clear();
    delete (globalThis as any).BroadcastChannel;
  });

  describe("fetch-start suppression", () => {
    it("should suppress local fetch when another tab broadcasts fetch-start", () => {
      store.initSync("test-channel");
      store.enableDedup(true);

      const observer = createTestObserver("s:key1" as HashedKey);
      store.attachObserver("s:key1" as HashedKey, observer, DEFAULT_CONFIG as any);

      // Simulate receiving fetch-start from another tab
      const sender = new FakeBroadcastChannel("test-channel");
      sender.postMessage({
        version: 1,
        type: "fetch-start",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        timestamp: Date.now(),
      } satisfies SyncMessage);

      // Now try to ensureFetch — should be suppressed since other tab is fetching
      let fetchCalled = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetchCalled = true;
        return "data";
      });

      // Fetch should NOT be called (dedup in action)
      expect(fetchCalled).toBe(false);

      store.closeSync();
      sender.close();
    });
  });

  describe("fetch-complete delivery", () => {
    it("should apply data from fetch-complete message", () => {
      store.initSync("test-channel");
      store.enableDedup(true);

      const observer = createTestObserver("s:key1" as HashedKey);
      store.attachObserver("s:key1" as HashedKey, observer, DEFAULT_CONFIG as any);

      // Simulate receiving fetch-complete from another tab
      const sender = new FakeBroadcastChannel("test-channel");
      sender.postMessage({
        version: 1,
        type: "fetch-complete",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        entry: { data: "result-from-other-tab", timestamp: Date.now() },
        timestamp: Date.now(),
      } satisfies SyncMessage);

      // Cache should be updated
      const cached = store.getCache("s:key1" as HashedKey);
      expect(cached?.data).toBe("result-from-other-tab");

      store.closeSync();
      sender.close();
    });
  });

  describe("fetch-error handling", () => {
    it("should handle fetch-error from another tab without crashing", () => {
      store.initSync("test-channel");
      store.enableDedup(true);

      const observer = createTestObserver("s:key1" as HashedKey);
      store.attachObserver("s:key1" as HashedKey, observer, DEFAULT_CONFIG as any);

      // Simulate receiving fetch-error from another tab
      const sender = new FakeBroadcastChannel("test-channel");
      sender.postMessage({
        version: 1,
        type: "fetch-error",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        error: {
          type: "network",
          message: "fetch failed",
          retryCount: 0,
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      } satisfies SyncMessage);

      // Remote inflight should be cleared, allowing local fetch to proceed
      let fetchCalled = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetchCalled = true;
        return "fallback-data";
      });

      // After error, local fetch should be allowed
      expect(fetchCalled).toBe(true);

      store.closeSync();
      sender.close();
    });
  });

  describe("dedup disabled", () => {
    it("should not suppress fetch when dedup is disabled (default)", () => {
      store.initSync("test-channel");
      // dedup is disabled by default

      const observer = createTestObserver("s:key1" as HashedKey);
      store.attachObserver("s:key1" as HashedKey, observer, DEFAULT_CONFIG as any);

      const sender = new FakeBroadcastChannel("test-channel");
      sender.postMessage({
        version: 1,
        type: "fetch-start",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        timestamp: Date.now(),
      } satisfies SyncMessage);

      let fetchCalled = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetchCalled = true;
        return "data";
      });

      // Fetch SHOULD be called (dedup is off)
      expect(fetchCalled).toBe(true);

      store.closeSync();
      sender.close();
    });
  });

  describe("remoteInflight timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should auto-clear remoteInflight after dedupTimeout fires", () => {
      store.initSync("test-channel");
      store.enableDedup(true, 5_000);

      const observer = createTestObserver("s:key1" as HashedKey);
      store.attachObserver("s:key1" as HashedKey, observer, DEFAULT_CONFIG as any);

      // Simulate fetch-start from another tab
      store.handleSyncMessage({
        version: 1,
        type: "fetch-start",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        timestamp: Date.now(),
      });

      // Should be suppressed before timeout
      let fetchCalled = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetchCalled = true;
        return "data";
      });
      expect(fetchCalled).toBe(false);

      // Advance past the timeout
      vi.advanceTimersByTime(5_000);

      // Now fetch should be allowed
      fetchCalled = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetchCalled = true;
        return "data";
      });
      expect(fetchCalled).toBe(true);

      store.closeSync();
    });

    it("should cancel timeout timer when fetch-complete arrives before timeout", () => {
      store.initSync("test-channel");
      store.enableDedup(true, 10_000);

      const observer = createTestObserver("s:key1" as HashedKey);
      store.attachObserver("s:key1" as HashedKey, observer, DEFAULT_CONFIG as any);

      // Simulate fetch-start
      store.handleSyncMessage({
        version: 1,
        type: "fetch-start",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        timestamp: Date.now(),
      });

      // fetch-complete arrives at 3s (before 10s timeout)
      vi.advanceTimersByTime(3_000);
      store.handleSyncMessage({
        version: 1,
        type: "fetch-complete",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        entry: { data: "result", timestamp: Date.now() },
        timestamp: Date.now(),
      });

      // Fetch should now be allowed (remoteInflight cleared by fetch-complete)
      let fetchCalled = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetchCalled = true;
        return "data";
      });
      expect(fetchCalled).toBe(true);

      // Verify no residual timer side-effects after original timeout would have fired
      vi.advanceTimersByTime(10_000);
      // Should still work fine — no unexpected state changes
      const cached = store.getCache("s:key1" as HashedKey);
      expect(cached?.data).toBe("result");

      store.closeSync();
    });

    it("should cancel timeout timer when fetch-error arrives before timeout", () => {
      store.initSync("test-channel");
      store.enableDedup(true, 10_000);

      const observer = createTestObserver("s:key1" as HashedKey);
      store.attachObserver("s:key1" as HashedKey, observer, DEFAULT_CONFIG as any);

      // Simulate fetch-start
      store.handleSyncMessage({
        version: 1,
        type: "fetch-start",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        timestamp: Date.now(),
      });

      // fetch-error arrives at 2s
      vi.advanceTimersByTime(2_000);
      store.handleSyncMessage({
        version: 1,
        type: "fetch-error",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        error: {
          type: "network",
          message: "fetch failed",
          retryCount: 0,
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      });

      // Fetch should be allowed now
      let fetchCalled = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetchCalled = true;
        return "data";
      });
      expect(fetchCalled).toBe(true);

      store.closeSync();
    });

    it("should clear all timers when enableDedup(false) is called", () => {
      store.initSync("test-channel");
      store.enableDedup(true, 10_000);

      // Attach observers so ensureFetch can proceed
      const observer1 = createTestObserver("s:key1" as HashedKey);
      store.attachObserver("s:key1" as HashedKey, observer1, DEFAULT_CONFIG as any);
      const observer2 = createTestObserver("s:key2" as HashedKey);
      store.attachObserver("s:key2" as HashedKey, observer2, DEFAULT_CONFIG as any);

      // Add multiple remote inflights
      store.handleSyncMessage({
        version: 1,
        type: "fetch-start",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        timestamp: Date.now(),
      });
      store.handleSyncMessage({
        version: 1,
        type: "fetch-start",
        tabId: "other-tab",
        key: "s:key2" as HashedKey,
        timestamp: Date.now(),
      });

      // Both should suppress fetches
      let fetch1Called = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetch1Called = true;
        return "data";
      });
      let fetch2Called = false;
      store.ensureFetch("s:key2" as HashedKey, "key2", () => {
        fetch2Called = true;
        return "data";
      });
      expect(fetch1Called).toBe(false);
      expect(fetch2Called).toBe(false);

      // Disable dedup — clears all timers and remoteInflight entries
      store.enableDedup(false);

      // Now fetches should be allowed
      fetch1Called = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetch1Called = true;
        return "data";
      });
      fetch2Called = false;
      store.ensureFetch("s:key2" as HashedKey, "key2", () => {
        fetch2Called = true;
        return "data";
      });
      expect(fetch1Called).toBe(true);
      expect(fetch2Called).toBe(true);

      // Advance past original timeout — no errors or unexpected behavior
      vi.advanceTimersByTime(10_000);

      store.closeSync();
    });

    it("should clear all timers on _reset()", () => {
      store.initSync("test-channel");
      store.enableDedup(true, 10_000);

      store.handleSyncMessage({
        version: 1,
        type: "fetch-start",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        timestamp: Date.now(),
      });

      // Reset should clear timers
      store._reset();

      // After reset, dedup is disabled, so fetch should work
      // Re-init to test
      store.initSync("test-channel");
      const observer = createTestObserver("s:key1" as HashedKey);
      store.attachObserver("s:key1" as HashedKey, observer, DEFAULT_CONFIG as any);

      let fetchCalled = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetchCalled = true;
        return "data";
      });
      expect(fetchCalled).toBe(true);

      // Advance past original timeout — should not cause errors
      vi.advanceTimersByTime(10_000);

      store.closeSync();
    });

    it("should use default timeout of 30s when no timeout is specified", () => {
      store.initSync("test-channel");
      store.enableDedup(true); // no timeout arg -> default 30_000

      const observer = createTestObserver("s:key1" as HashedKey);
      store.attachObserver("s:key1" as HashedKey, observer, DEFAULT_CONFIG as any);

      store.handleSyncMessage({
        version: 1,
        type: "fetch-start",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        timestamp: Date.now(),
      });

      // Still suppressed at 29s
      vi.advanceTimersByTime(29_999);
      let fetchCalled = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetchCalled = true;
        return "data";
      });
      expect(fetchCalled).toBe(false);

      // Cleared at 30s
      vi.advanceTimersByTime(1);
      fetchCalled = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetchCalled = true;
        return "data";
      });
      expect(fetchCalled).toBe(true);

      store.closeSync();
    });

    it("should reset timer when fetch-start is received again for the same key", () => {
      store.initSync("test-channel");
      store.enableDedup(true, 5_000);

      const observer = createTestObserver("s:key1" as HashedKey);
      store.attachObserver("s:key1" as HashedKey, observer, DEFAULT_CONFIG as any);

      // First fetch-start
      store.handleSyncMessage({
        version: 1,
        type: "fetch-start",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        timestamp: Date.now(),
      });

      // Advance 3s, then send another fetch-start (retry from remote tab)
      vi.advanceTimersByTime(3_000);
      store.handleSyncMessage({
        version: 1,
        type: "fetch-start",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        timestamp: Date.now(),
      });

      // At 5s total (2s after second fetch-start), should still be suppressed
      vi.advanceTimersByTime(2_000);
      let fetchCalled = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetchCalled = true;
        return "data";
      });
      expect(fetchCalled).toBe(false);

      // At 8s total (5s after second fetch-start), timeout should fire
      vi.advanceTimersByTime(3_000);
      fetchCalled = false;
      store.ensureFetch("s:key1" as HashedKey, "key1", () => {
        fetchCalled = true;
        return "data";
      });
      expect(fetchCalled).toBe(true);

      store.closeSync();
    });
  });
});
