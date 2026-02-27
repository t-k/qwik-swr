import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initEventManager } from "../../src/cache/event-manager.ts";
import { store } from "../../src/cache/store.ts";
import type { HashedKey, ResolvedSWROptions, FetcherCtx } from "../../src/types/index.ts";
import type { Observer } from "../../src/cache/types.ts";

// ===================================================================
// Helpers (mirroring store.test.ts patterns)
// ===================================================================

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

/**
 * Flush all pending microtasks and timers.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

// ===================================================================
// Setup
// ===================================================================

beforeEach(() => {
  vi.useFakeTimers();
  store._reset();
  observerIdCounter = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ===================================================================
// Integration: Revalidation triggers
// ===================================================================

describe("Integration: Revalidation triggers", () => {
  // ----- Focus trigger -----

  describe("focus trigger", () => {
    it("calls handler on window focus event", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["focus"], handler);

      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(100);

      expect(handler).toHaveBeenCalledTimes(1);
      cleanup();
    });

    it("debounces rapid focus events within 100ms", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["focus"], handler);

      // Fire focus rapidly 5 times within 100ms
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(20);
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(20);
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(20);
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(20);
      window.dispatchEvent(new Event("focus"));

      // Wait for the debounce timer to flush
      vi.advanceTimersByTime(100);

      // Only one call despite 5 rapid focus events
      expect(handler).toHaveBeenCalledTimes(1);
      cleanup();
    });
  });

  // ----- Reconnect trigger -----

  describe("reconnect trigger", () => {
    it("calls handler on online event", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["reconnect"], handler);

      window.dispatchEvent(new Event("online"));

      expect(handler).toHaveBeenCalledTimes(1);
      cleanup();
    });

    it("sets store offline on offline event", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["reconnect"], handler);

      // Verify initially online
      expect(store.isOnline).toBe(true);

      // Dispatch offline event
      window.dispatchEvent(new Event("offline"));

      // Store should reflect offline state
      expect(store.isOnline).toBe(false);

      // Handler should NOT be called on offline (only on online)
      expect(handler).not.toHaveBeenCalled();

      // Restore online state for other tests
      window.dispatchEvent(new Event("online"));
      cleanup();
    });
  });

  // ----- Timeout -----

  describe("timeout", () => {
    it("aborts fetch when timeout exceeded", async () => {
      const KEY = "s:/api/timeout-test" as HashedKey;
      const observer = makeObserver(KEY);
      const opts = makeOptions({ timeout: 500, retry: 0 });
      store.attachObserver(KEY, observer, opts);

      // Track the AbortSignal to verify it was aborted
      let capturedSignal: AbortSignal | null = null;

      // Slow fetcher that takes 2000ms (well beyond the 500ms timeout)
      const fetcher = vi.fn(
        (ctx: FetcherCtx) =>
          new Promise<string>((resolve, reject) => {
            capturedSignal = ctx.signal;
            const timer = setTimeout(() => resolve("slow-data"), 2000);
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      );

      store.ensureFetch(KEY, "/api/timeout-test", fetcher);
      await flush();

      // Fetcher should have been called
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(capturedSignal).not.toBeNull();
      expect(capturedSignal!.aborted).toBe(false);

      // Advance past the timeout threshold (500ms)
      await vi.advanceTimersByTimeAsync(600);

      // The AbortSignal should have been triggered by the store's timeout
      expect(capturedSignal!.aborted).toBe(true);

      // Data should NOT have been committed to cache
      const cached = store.getCache<string>(KEY);
      expect(cached).toBeNull();

      // The store silently discards aborted fetches (no onError for abort),
      // so observer.onData should not have been called with slow-data
      const dataCalls = vi.mocked(observer.onData).mock.calls;
      const hasSlowData = dataCalls.some((call) => (call[0] as any)?.data === "slow-data");
      expect(hasSlowData).toBe(false);
    });
  });

  // ----- Cleanup -----

  describe("cleanup removes all listeners", () => {
    it("removes focus and reconnect listeners after cleanup", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["focus", "reconnect"], handler);

      // Call cleanup to remove all listeners
      cleanup();

      // Fire focus event - should NOT trigger handler
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(100);

      // Fire online event - should NOT trigger handler
      window.dispatchEvent(new Event("online"));

      // Fire offline event - should NOT affect store
      // (We need to save current online state for comparison)
      const onlineBefore = store.isOnline;
      window.dispatchEvent(new Event("offline"));

      expect(handler).not.toHaveBeenCalled();
      // store.isOnline should remain unchanged since listener was removed
      expect(store.isOnline).toBe(onlineBefore);
    });

    it("removes visibilitychange listener after cleanup", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["focus"], handler);

      cleanup();

      // Simulate becoming visible
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(100);

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
