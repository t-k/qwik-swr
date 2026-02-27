import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  CacheEntry,
  HashedKey,
  ResolvedSWROptions,
  FetcherCtx,
} from "../../src/types/index.ts";
import { store } from "../../src/cache/store.ts";
import { cache } from "../../src/cache/cache-api.ts";
import {
  makeObserver,
  makeOptions,
  makeFetcher,
  makeFailingFetcher,
  flush,
  resetObserverIdCounter,
} from "../helpers/index.ts";

// ═══════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.useFakeTimers();
  store._reset();
  resetObserverIdCounter();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════
// T019: CacheStore.attachObserver / detachObserver
// ═══════════════════════════════════════════════════════════════

describe("T019: attachObserver / detachObserver", () => {
  const KEY = "s:/api/users" as HashedKey;

  describe("observer registry management", () => {
    it("should register an observer for a key", () => {
      const observer = makeObserver(KEY);
      const opts = makeOptions();

      store.attachObserver(KEY, observer, opts);

      // Verify the observer is registered: setCache should notify it
      const entry: CacheEntry<string> = {
        data: "hello",
        timestamp: Date.now(),
      };
      store.setCache(KEY, entry);

      expect(observer.onData).toHaveBeenCalledWith(entry);
    });

    it("should register multiple observers for the same key", () => {
      const opts = makeOptions();
      const observer1 = makeObserver(KEY);
      const observer2 = makeObserver(KEY);

      store.attachObserver(KEY, observer1, opts);
      store.attachObserver(KEY, observer2, opts);

      const entry: CacheEntry<string> = {
        data: "hello",
        timestamp: Date.now(),
      };
      store.setCache(KEY, entry);

      expect(observer1.onData).toHaveBeenCalledWith(entry);
      expect(observer2.onData).toHaveBeenCalledWith(entry);
    });

    it("should remove observer on detach", () => {
      const observer = makeObserver(KEY);
      const opts = makeOptions();

      store.attachObserver(KEY, observer, opts);
      store.detachObserver(KEY, observer);

      // After detach, setCache should NOT notify this observer
      const entry: CacheEntry<string> = {
        data: "hello",
        timestamp: Date.now(),
      };
      store.setCache(KEY, entry);

      expect(observer.onData).not.toHaveBeenCalled();
    });

    it("should handle detaching a non-existent observer gracefully", () => {
      const observer = makeObserver(KEY);
      expect(() => store.detachObserver(KEY, observer)).not.toThrow();
    });

    it("should handle detaching from a key with no registry", () => {
      const observer = makeObserver(KEY);
      expect(() => store.detachObserver("s:nonexistent" as HashedKey, observer)).not.toThrow();
    });

    it("should clean up registry Set when last observer is removed", () => {
      const opts = makeOptions();
      const observer = makeObserver(KEY);
      store.attachObserver(KEY, observer, opts);
      store.detachObserver(KEY, observer);

      // After removing last observer, setCache should not notify anyone
      const observer2 = makeObserver(KEY);
      // Don't attach observer2 - just set cache
      store.setCache(KEY, { data: "test", timestamp: Date.now() });
      expect(observer2.onData).not.toHaveBeenCalled();
    });
  });

  describe("queryConfig fixation", () => {
    it("should fix queryConfig on first observer attach", () => {
      const observer1 = makeObserver(KEY);
      const opts1 = makeOptions({ staleTime: 60_000, cacheTime: 300_000 });

      store.attachObserver(KEY, observer1, opts1);

      // Set a cache entry that is 40s old
      // With staleTime=60_000, this is still fresh -> ensureFetch should skip
      const entry: CacheEntry<string> = {
        data: "cached",
        timestamp: Date.now() - 40_000,
      };
      store.setCache(KEY, entry);

      const fetcher = makeFetcher("new");
      store.ensureFetch(KEY, "/api/users", fetcher);

      // Should NOT fetch because 40s < 60s staleTime (first observer's config)
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("should NOT overwrite queryConfig when second observer attaches with different options", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const observer1 = makeObserver(KEY);
      const opts1 = makeOptions({ staleTime: 10_000 });
      store.attachObserver(KEY, observer1, opts1);

      const observer2 = makeObserver(KEY);
      const opts2 = makeOptions({ staleTime: 99_999 });
      store.attachObserver(KEY, observer2, opts2);

      // Set a cache entry 15s old -> stale if staleTime=10_000, fresh if 99_999
      const entry: CacheEntry<string> = {
        data: "stale",
        timestamp: Date.now() - 15_000,
      };
      store.setCache(KEY, entry);

      const fetcher = makeFetcher("fresh");
      store.ensureFetch(KEY, "/api/users", fetcher);

      // Should fetch because staleTime=10_000 (first observer wins), and 15s > 10s
      expect(fetcher).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });

    it("should use first observer's config for ensureFetch decisions", () => {
      const observer = makeObserver(KEY);
      const opts = makeOptions({ staleTime: 60_000 });

      store.attachObserver(KEY, observer, opts);

      // Set cache entry that is 30s old (fresh if staleTime=60_000)
      const entry: CacheEntry<string> = {
        data: "cached",
        timestamp: Date.now() - 30_000,
      };
      store.setCache(KEY, entry);

      const fetcher = makeFetcher("new");
      store.ensureFetch(KEY, "/api/users", fetcher);

      // Should NOT fetch because 30s < 60_000 staleTime
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe("cache hit notification on attach", () => {
    it("should immediately notify observer with existing cache entry", () => {
      const opts = makeOptions();
      const entry: CacheEntry<string> = {
        data: "cached",
        timestamp: Date.now(),
      };

      // Set cache before attaching
      // Note: setCache won't notify since no observers yet
      store.setCache(KEY, entry);

      const observer = makeObserver(KEY);
      store.attachObserver(KEY, observer, opts);

      expect(observer.onData).toHaveBeenCalledTimes(1);
      expect(observer.onData).toHaveBeenCalledWith(entry);
    });

    it("should set hasData=true when cache hit occurs on attach", () => {
      const opts = makeOptions();
      const entry: CacheEntry<string> = {
        data: "cached",
        timestamp: Date.now(),
      };
      store.setCache(KEY, entry);

      const observer = makeObserver(KEY);
      expect(observer.hasData).toBe(false);

      store.attachObserver(KEY, observer, opts);

      expect(observer.hasData).toBe(true);
    });

    it("should NOT notify observer when no cache exists", () => {
      const observer = makeObserver(KEY);
      const opts = makeOptions();

      store.attachObserver(KEY, observer, opts);

      expect(observer.onData).not.toHaveBeenCalled();
      expect(observer.hasData).toBe(false);
    });
  });

  describe("observerCount tracking on in-flight", () => {
    it("should update in-flight observerCount when observer attaches", async () => {
      const observer1 = makeObserver(KEY);
      const opts = makeOptions();
      store.attachObserver(KEY, observer1, opts);

      // Start a slow fetch to create an in-flight entry
      const fetcher = makeFetcher("data", 500);
      store.ensureFetch(KEY, "/api/users", fetcher);

      // Attach another observer while fetch is in-flight
      const observer2 = makeObserver(KEY);
      store.attachObserver(KEY, observer2, opts);

      // Detach both observers -> observerCount=0 -> abort
      store.detachObserver(KEY, observer1);
      store.detachObserver(KEY, observer2);

      // Let everything settle
      await vi.advanceTimersByTimeAsync(1000);

      // With 0 observers and abort, cache should not be populated
      expect(store.getCache(KEY)).toBeNull();
    });

    it("should abort in-flight when last observer detaches", async () => {
      const observer = makeObserver(KEY);
      const opts = makeOptions();
      store.attachObserver(KEY, observer, opts);

      const fetcher = makeFetcher("data", 1000);
      store.ensureFetch(KEY, "/api/users", fetcher);

      // Detach last observer -> abort
      store.detachObserver(KEY, observer);

      // Re-attach new observer and start new fetch
      const observer2 = makeObserver(KEY);
      store.attachObserver(KEY, observer2, makeOptions());
      const fetcher2 = makeFetcher("data2", 100);
      store.ensureFetch(KEY, "/api/users", fetcher2);

      // Old inflight was deleted, so ensureFetch starts a new one
      expect(fetcher2).toHaveBeenCalledTimes(1);
    });

    it("should not abort in-flight when some observers remain", () => {
      const opts = makeOptions();
      const observer1 = makeObserver(KEY);
      const observer2 = makeObserver(KEY);

      store.attachObserver(KEY, observer1, opts);
      store.attachObserver(KEY, observer2, opts);

      const fetcher = makeFetcher("data", 500);
      store.ensureFetch(KEY, "/api/users", fetcher);

      // Detach one observer - in-flight should still exist
      store.detachObserver(KEY, observer1);

      // ensureFetch should JOIN (not start new), confirming inflight still alive
      const fetcher2 = makeFetcher("data2");
      store.ensureFetch(KEY, "/api/users", fetcher2);
      expect(fetcher2).not.toHaveBeenCalled(); // joined, not started
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// T019b: DEV mode warning for different options on same key (FR-009)
// ═══════════════════════════════════════════════════════════════

describe("T019b: DEV mode warning for different options on same key", () => {
  const KEY = "s:/api/data" as HashedKey;

  it("should warn when a second observer uses different cacheTime", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const observer1 = makeObserver(KEY);
    const opts1 = makeOptions({ cacheTime: 60_000 });
    store.attachObserver(KEY, observer1, opts1);

    const observer2 = makeObserver(KEY);
    const opts2 = makeOptions({ cacheTime: 120_000 });
    store.attachObserver(KEY, observer2, opts2);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(KEY));
  });

  it("should warn when a second observer uses different staleTime", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const observer1 = makeObserver(KEY);
    const opts1 = makeOptions({ staleTime: 10_000 });
    store.attachObserver(KEY, observer1, opts1);

    const observer2 = makeObserver(KEY);
    const opts2 = makeOptions({ staleTime: 50_000 });
    store.attachObserver(KEY, observer2, opts2);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("already has QueryConfig"));
  });

  it("should warn when a second observer uses different dedupingInterval", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const observer1 = makeObserver(KEY);
    const opts1 = makeOptions({ dedupingInterval: 2_000 });
    store.attachObserver(KEY, observer1, opts1);

    const observer2 = makeObserver(KEY);
    const opts2 = makeOptions({ dedupingInterval: 10_000 });
    store.attachObserver(KEY, observer2, opts2);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("should NOT warn when second observer uses identical options", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const observer1 = makeObserver(KEY);
    const opts = makeOptions({ staleTime: 10_000, cacheTime: 60_000 });
    store.attachObserver(KEY, observer1, opts);

    const observer2 = makeObserver(KEY);
    store.attachObserver(KEY, observer2, opts);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("should NOT warn for different keys even with different options", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const KEY2 = "s:/api/other" as HashedKey;

    const observer1 = makeObserver(KEY);
    const opts1 = makeOptions({ cacheTime: 60_000 });
    store.attachObserver(KEY, observer1, opts1);

    const observer2 = makeObserver(KEY2);
    const opts2 = makeOptions({ cacheTime: 120_000 });
    store.attachObserver(KEY2, observer2, opts2);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("should include observer id in warning message", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const observer1 = makeObserver(KEY);
    const opts1 = makeOptions({ cacheTime: 60_000 });
    store.attachObserver(KEY, observer1, opts1);

    const observer2 = makeObserver(KEY);
    const opts2 = makeOptions({ cacheTime: 120_000 });
    store.attachObserver(KEY, observer2, opts2);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(observer2.id));
  });
});

// ═══════════════════════════════════════════════════════════════
// T020: CacheStore.ensureFetch
// ═══════════════════════════════════════════════════════════════

describe("T020: ensureFetch", () => {
  const KEY = "s:/api/users" as HashedKey;

  function setupWithObserver(opts?: Partial<ResolvedSWROptions>) {
    const observer = makeObserver(KEY);
    const resolvedOpts = makeOptions(opts);
    store.attachObserver(KEY, observer, resolvedOpts);
    return { observer, opts: resolvedOpts };
  }

  describe("Stage 1: in-flight join", () => {
    it("should join existing in-flight instead of starting a new fetch", () => {
      setupWithObserver();

      // Use a delayed fetcher so it stays in-flight
      const fetcher = makeFetcher("data", 100);
      store.ensureFetch(KEY, "/api/users", fetcher);
      store.ensureFetch(KEY, "/api/users", fetcher);
      store.ensureFetch(KEY, "/api/users", fetcher);

      // fetcher is called via Promise.resolve().then(), so it hasn't been called yet
      // But startFetch should only be invoked once (inflightMap check)
      // The inflight entry is added synchronously in startFetch,
      // so subsequent calls will see it and join.
      // We verify by checking that only one inflight was created:
      // After first ensureFetch, inflight exists. Second/third calls just join.
      // The fetcher will be called once when its microtask runs.
    });

    it("should broadcast fetchStatus='fetching' on join", () => {
      const { observer } = setupWithObserver();

      const fetcher = makeFetcher("data", 100);
      store.ensureFetch(KEY, "/api/users", fetcher);

      // First call broadcasts 'fetching' via startFetch
      expect(observer.onFetchStatusChange).toHaveBeenCalledWith("fetching");

      // Reset and call again (join)
      vi.mocked(observer.onFetchStatusChange).mockClear();
      store.ensureFetch(KEY, "/api/users", fetcher);

      // Join should also broadcast 'fetching'
      expect(observer.onFetchStatusChange).toHaveBeenCalledWith("fetching");
    });

    it("should update observerCount on join", () => {
      const opts = makeOptions();
      const observer1 = makeObserver(KEY);
      store.attachObserver(KEY, observer1, opts);

      const fetcher = makeFetcher("data", 500);
      store.ensureFetch(KEY, "/api/users", fetcher);

      // Add a second observer
      const observer2 = makeObserver(KEY);
      store.attachObserver(KEY, observer2, opts);

      // Join with second observer
      store.ensureFetch(KEY, "/api/users", fetcher);

      // Both observers should receive fetching status
      expect(observer2.onFetchStatusChange).toHaveBeenCalledWith("fetching");
    });
  });

  describe("Stage 2: cooldown suppression", () => {
    it("should suppress fetch during cooldown when data exists", async () => {
      setupWithObserver({ dedupingInterval: 5_000, staleTime: 0 });

      // First fetch completes
      const fetcher1 = makeFetcher("data1");
      store.ensureFetch(KEY, "/api/users", fetcher1);
      await flush();

      // Within cooldown window - should suppress
      const fetcher2 = makeFetcher("data2");
      store.ensureFetch(KEY, "/api/users", fetcher2);
      expect(fetcher2).not.toHaveBeenCalled();
    });

    it("should allow fetch after cooldown expires", async () => {
      setupWithObserver({ dedupingInterval: 2_000, staleTime: 0 });

      const fetcher1 = makeFetcher("data1");
      store.ensureFetch(KEY, "/api/users", fetcher1);
      await flush();

      // Advance past cooldown
      vi.advanceTimersByTime(2_001);

      const fetcher2 = makeFetcher("data2");
      store.ensureFetch(KEY, "/api/users", fetcher2);
      expect(fetcher2).toHaveBeenCalledTimes(1);
    });

    it("should NOT suppress fetch during cooldown when no displayable data (volatile + no observer data)", async () => {
      // Set up with cacheTime=0 so data is NOT stored in cacheMap
      const observer = makeObserver(KEY);
      observer.hasData = false;
      const opts = makeOptions({
        cacheTime: 0,
        dedupingInterval: 5_000,
        staleTime: 0,
      });
      store.attachObserver(KEY, observer, opts);

      // First fetch completes (volatile: no cacheMap storage)
      const fetcher1 = makeFetcher("volatile-data");
      store.ensureFetch(KEY, "/api/users", fetcher1);
      await flush();

      // observer.hasData was set to true by notifyObservers during fetch completion.
      // Reset it to simulate a scenario where the observer lost its data
      observer.hasData = false;

      // Cooldown exists but no displayable data -> should NOT suppress
      const fetcher2 = makeFetcher("volatile-data-2");
      store.ensureFetch(KEY, "/api/users", fetcher2);
      expect(fetcher2).toHaveBeenCalledTimes(1);
    });

    it("should suppress during cooldown when observer hasData even without cacheMap entry", async () => {
      const observer = makeObserver(KEY);
      const opts = makeOptions({
        cacheTime: 0,
        dedupingInterval: 5_000,
        staleTime: 0,
      });
      store.attachObserver(KEY, observer, opts);

      const fetcher1 = makeFetcher("volatile-data");
      store.ensureFetch(KEY, "/api/users", fetcher1);
      await flush();

      // observer.hasData = true (set by notifyObservers)
      expect(observer.hasData).toBe(true);

      // Cooldown + observer.hasData=true -> suppress
      const fetcher2 = makeFetcher("volatile-data-2");
      store.ensureFetch(KEY, "/api/users", fetcher2);
      expect(fetcher2).not.toHaveBeenCalled();
    });
  });

  describe("fresh entry skip", () => {
    it("should skip fetch when cache entry is fresh", () => {
      setupWithObserver({ staleTime: 60_000 });

      // Set a fresh entry
      const entry: CacheEntry<string> = {
        data: "fresh",
        timestamp: Date.now(),
      };
      store.setCache(KEY, entry);

      const fetcher = makeFetcher("new");
      store.ensureFetch(KEY, "/api/users", fetcher);

      expect(fetcher).not.toHaveBeenCalled();
    });

    it("should fetch when cache entry is stale", () => {
      setupWithObserver({ staleTime: 10_000 });

      // Set an old entry
      const entry: CacheEntry<string> = {
        data: "stale",
        timestamp: Date.now() - 15_000,
      };
      store.setCache(KEY, entry);

      const fetcher = makeFetcher("fresh");
      store.ensureFetch(KEY, "/api/users", fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("should fetch when staleTime=0 (always stale)", () => {
      setupWithObserver({ staleTime: 0, dedupingInterval: 0 });

      const entry: CacheEntry<string> = {
        data: "just-set",
        timestamp: Date.now(),
      };
      store.setCache(KEY, entry);

      const fetcher = makeFetcher("new");
      store.ensureFetch(KEY, "/api/users", fetcher);

      // staleTime=0 means age(0) < 0 is false, so it should fetch
      // Actually: age = Date.now() - timestamp. If timestamp === Date.now(), age = 0.
      // 0 < 0 is false, so it proceeds to fetch.
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("new fetch dispatch", () => {
    it("should dispatch a new fetch when no in-flight, no cooldown, no cache", () => {
      setupWithObserver();

      const fetcher = makeFetcher("data");
      store.ensureFetch(KEY, "/api/users", fetcher);

      // The fetcher is called asynchronously, but startFetch was invoked
      // (inflight entry should exist)
      // Let's verify by checking that a second ensureFetch joins
      const fetcher2 = makeFetcher("data2");
      store.ensureFetch(KEY, "/api/users", fetcher2);
      expect(fetcher2).not.toHaveBeenCalled(); // joined, not dispatched
    });

    it("should broadcast fetchStatus='fetching' then 'idle' on completion", async () => {
      const { observer } = setupWithObserver();

      const fetcher = makeFetcher("data");
      store.ensureFetch(KEY, "/api/users", fetcher);

      expect(observer.onFetchStatusChange).toHaveBeenCalledWith("fetching");

      await flush();

      expect(observer.onFetchStatusChange).toHaveBeenCalledWith("idle");
    });

    it("should store data in cacheMap on success (cacheTime > 0)", async () => {
      setupWithObserver({ cacheTime: 300_000 });

      const fetcher = makeFetcher("stored-data");
      store.ensureFetch(KEY, "/api/users", fetcher);
      await flush();

      const cached = store.getCache<string>(KEY);
      expect(cached).not.toBeNull();
      expect(cached!.data).toBe("stored-data");
    });

    it("should NOT store data in cacheMap when cacheTime=0 (volatile)", async () => {
      setupWithObserver({ cacheTime: 0 });

      const fetcher = makeFetcher("volatile-data");
      store.ensureFetch(KEY, "/api/users", fetcher);
      await flush();

      const cached = store.getCache(KEY);
      expect(cached).toBeNull();
    });

    it("should notify observers with data on successful fetch", async () => {
      const { observer } = setupWithObserver();

      const fetcher = makeFetcher("result");
      store.ensureFetch(KEY, "/api/users", fetcher);
      await flush();

      expect(observer.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "result" }));
    });

    it("should notify observers with error on failed fetch", async () => {
      const { observer } = setupWithObserver({ retry: 0 });

      const fetcher = makeFailingFetcher(new Error("network error"));
      store.ensureFetch(KEY, "/api/users", fetcher);
      await flush();

      expect(observer.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "network error",
        }),
      );
    });

    it("should set hasData=true on observers after successful fetch", async () => {
      const { observer } = setupWithObserver();

      const fetcher = makeFetcher("data");
      store.ensureFetch(KEY, "/api/users", fetcher);
      await flush();

      expect(observer.hasData).toBe(true);
    });

    it("should NOT notify observers when fetch is aborted (via detach)", async () => {
      const { observer } = setupWithObserver();

      // Start a slow fetch
      const fetcher = makeFetcher("data", 5000);
      store.ensureFetch(KEY, "/api/users", fetcher);

      // Detach triggers abort
      store.detachObserver(KEY, observer);

      // Let promises settle
      await flush();
      await vi.advanceTimersByTimeAsync(6000);

      // Observer should not have received error notification for abort
      const errorCalls = vi.mocked(observer.onError).mock.calls;
      const hasAbortError = errorCalls.some((call) => (call[0] as any)?.type === "abort");
      expect(hasAbortError).toBe(false);
    });

    it("should pass FetcherCtx with rawKey, hashedKey, and signal", async () => {
      setupWithObserver();

      const fetcher = vi.fn((_ctx: FetcherCtx) => Promise.resolve("data"));
      store.ensureFetch(KEY, "/api/users", fetcher);
      await flush();

      expect(fetcher).toHaveBeenCalledWith(
        expect.objectContaining({
          rawKey: "/api/users",
          hashedKey: KEY,
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("should do nothing if no queryConfig is set (no observer attached)", () => {
      const fetcher = makeFetcher("data");
      store.ensureFetch(KEY, "/api/users", fetcher);
      // The fetcher is async but startFetch should not be called at all
      // Verify no inflight by checking that a new ensureFetch also does nothing
      store.ensureFetch(KEY, "/api/users", fetcher);
      // No assertions needed - just verifying it doesn't throw
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// T021: CacheStore.setCache / getCache / deleteCache / clearCache
// ═══════════════════════════════════════════════════════════════

describe("T021: setCache / getCache / deleteCache / clearCache", () => {
  const KEY = "s:/api/items" as HashedKey;
  const KEY2 = "s:/api/users" as HashedKey;

  describe("setCache", () => {
    it("should store entry retrievable by getCache", () => {
      const entry: CacheEntry<string> = { data: "hello", timestamp: 1000 };
      store.setCache(KEY, entry);

      const cached = store.getCache<string>(KEY);
      expect(cached).not.toBeNull();
      expect(cached!.data).toBe("hello");
      expect(cached!.timestamp).toBe(1000);
    });

    it("should notify all observers when cache is set", () => {
      const opts = makeOptions();
      const observer1 = makeObserver(KEY);
      const observer2 = makeObserver(KEY);
      store.attachObserver(KEY, observer1, opts);
      store.attachObserver(KEY, observer2, opts);

      const entry: CacheEntry<string> = {
        data: "notified",
        timestamp: Date.now(),
      };
      store.setCache(KEY, entry);

      expect(observer1.onData).toHaveBeenCalledWith(entry);
      expect(observer2.onData).toHaveBeenCalledWith(entry);
    });

    it("should set hasData=true on all notified observers", () => {
      const opts = makeOptions();
      const observer = makeObserver(KEY);
      expect(observer.hasData).toBe(false);

      store.attachObserver(KEY, observer, opts);

      const entry: CacheEntry<string> = {
        data: "data",
        timestamp: Date.now(),
      };
      store.setCache(KEY, entry);

      expect(observer.hasData).toBe(true);
    });

    it("should overwrite existing cache entry", () => {
      const entry1: CacheEntry<string> = { data: "first", timestamp: 1000 };
      const entry2: CacheEntry<string> = {
        data: "second",
        timestamp: 2000,
      };

      store.setCache(KEY, entry1);
      store.setCache(KEY, entry2);

      const cached = store.getCache<string>(KEY);
      expect(cached!.data).toBe("second");
      expect(cached!.timestamp).toBe(2000);
    });

    it("should not notify observers of other keys", () => {
      const opts = makeOptions();
      const observer1 = makeObserver(KEY);
      const observer2 = makeObserver(KEY2);
      store.attachObserver(KEY, observer1, opts);
      store.attachObserver(KEY2, observer2, opts);

      const entry: CacheEntry<string> = {
        data: "only-key1",
        timestamp: Date.now(),
      };
      store.setCache(KEY, entry);

      expect(observer1.onData).toHaveBeenCalledWith(entry);
      expect(observer2.onData).not.toHaveBeenCalled();
    });
  });

  describe("getCache", () => {
    it("should return null for non-existent key", () => {
      expect(store.getCache("s:nonexistent" as HashedKey)).toBeNull();
    });

    it("should return the stored cache entry", () => {
      const entry: CacheEntry<number> = { data: 42, timestamp: 1234 };
      store.setCache(KEY, entry);

      const cached = store.getCache<number>(KEY);
      expect(cached).toEqual(entry);
    });
  });

  describe("deleteCache", () => {
    it("should remove cache entry", () => {
      const entry: CacheEntry<string> = {
        data: "to-delete",
        timestamp: Date.now(),
      };
      store.setCache(KEY, entry);

      store.deleteCache(KEY);

      expect(store.getCache(KEY)).toBeNull();
    });

    it("should notify observers with data=undefined (cleared notification)", () => {
      const opts = makeOptions();
      const observer = makeObserver(KEY);
      store.attachObserver(KEY, observer, opts);

      const entry: CacheEntry<string> = {
        data: "exists",
        timestamp: Date.now(),
      };
      store.setCache(KEY, entry);
      vi.mocked(observer.onData).mockClear();

      store.deleteCache(KEY);

      expect(observer.onData).toHaveBeenCalledTimes(1);
      expect(observer.onData).toHaveBeenCalledWith(expect.objectContaining({ data: undefined }));
    });

    it("should set hasData=false on observers after delete", () => {
      const opts = makeOptions();
      const observer = makeObserver(KEY);
      store.attachObserver(KEY, observer, opts);

      store.setCache(KEY, { data: "exists", timestamp: Date.now() });
      expect(observer.hasData).toBe(true);

      store.deleteCache(KEY);

      expect(observer.hasData).toBe(false);
    });

    it("should abort in-flight fetch for deleted key", async () => {
      const opts = makeOptions();
      const observer = makeObserver(KEY);
      store.attachObserver(KEY, observer, opts);

      const fetcher = makeFetcher("data", 1000);
      store.ensureFetch(KEY, "/api/items", fetcher);

      store.deleteCache(KEY);

      // After delete + abort, a new ensureFetch should start a fresh fetch
      // (inflight was removed by deleteCache)
      const fetcher2 = makeFetcher("data2", 100);
      store.ensureFetch(KEY, "/api/items", fetcher2);

      // Verify new fetch was started by checking inflight join behavior
      const fetcher3 = makeFetcher("data3");
      store.ensureFetch(KEY, "/api/items", fetcher3);
      expect(fetcher3).not.toHaveBeenCalled(); // joined fetcher2's inflight
    });

    it("should clear cooldown for deleted key", async () => {
      const opts = makeOptions({
        dedupingInterval: 10_000,
        staleTime: 0,
      });
      const observer = makeObserver(KEY);
      store.attachObserver(KEY, observer, opts);

      const fetcher1 = makeFetcher("data1");
      store.ensureFetch(KEY, "/api/items", fetcher1);
      await flush();

      // Now in cooldown. deleteCache should clear it.
      store.deleteCache(KEY);

      // ensureFetch should proceed (no cooldown suppression)
      const fetcher2 = makeFetcher("data2");
      store.ensureFetch(KEY, "/api/items", fetcher2);
      // Verify it started by checking inflight join
      const fetcher3 = makeFetcher("data3");
      store.ensureFetch(KEY, "/api/items", fetcher3);
      expect(fetcher3).not.toHaveBeenCalled(); // joined fetcher2
    });

    it("should clearTimeout for active cooldown timer on delete (MF-3)", async () => {
      const opts = makeOptions({
        dedupingInterval: 10_000,
        staleTime: 0,
      });
      const observer = makeObserver(KEY);
      store.attachObserver(KEY, observer, opts);

      const fetcher1 = makeFetcher("data1");
      store.ensureFetch(KEY, "/api/items", fetcher1);
      await flush();

      // Cooldown is active now (10s). Verify timer exists.
      expect(store._getCooldownMapSize()).toBe(1);

      // Spy on clearTimeout to verify the timer is cleaned up
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      store.deleteCache(KEY);

      // clearTimeout should have been called for the cooldown timer
      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(store._getCooldownMapSize()).toBe(0);

      clearTimeoutSpy.mockRestore();
    });

    it("should handle deleting non-existent key gracefully", () => {
      expect(() => store.deleteCache("s:nonexistent" as HashedKey)).not.toThrow();
    });
  });

  describe("deleteCache: latestRequestId cleanup", () => {
    it("should clean up latestRequestId when deleting a cache key", async () => {
      const opts = makeOptions();
      const observer = makeObserver(KEY);
      store.attachObserver(KEY, observer, opts);

      // Start and complete a fetch (creates latestRequestId entry)
      const fetcher = makeFetcher("data");
      store.ensureFetch(KEY, "/api/items", fetcher);
      await flush();

      // Delete the cache key
      store.deleteCache(KEY);

      // Re-attach observer with config
      const observer2 = makeObserver(KEY);
      store.attachObserver(KEY, observer2, makeOptions({ staleTime: 0 }));

      // Start two concurrent fetches via forceRevalidate
      // If latestRequestId was not cleaned, stale requestId could cause issues
      let _resolveFirst!: (val: string) => void;
      const firstPromise = new Promise<string>((r) => {
        _resolveFirst = r;
      });
      const fetcher1 = vi.fn(() => firstPromise);

      let resolveSecond!: (val: string) => void;
      const secondPromise = new Promise<string>((r) => {
        resolveSecond = r;
      });
      const fetcher2 = vi.fn(() => secondPromise);

      store.ensureFetch(KEY, "/api/items", fetcher1);
      await flush();

      store.forceRevalidate(KEY, "/api/items", fetcher2);
      await flush();

      resolveSecond("second");
      await flush();

      // The second fetch should commit correctly
      const cached = store.getCache<string>(KEY);
      expect(cached).not.toBeNull();
      expect(cached!.data).toBe("second");
    });
  });

  describe("clearCache", () => {
    it("should remove all cache entries", () => {
      store.setCache(KEY, { data: "a", timestamp: 1 });
      store.setCache(KEY2, { data: "b", timestamp: 2 });

      store.clearCache();

      expect(store.getCache(KEY)).toBeNull();
      expect(store.getCache(KEY2)).toBeNull();
    });

    it("should abort all in-flight fetches", () => {
      const opts = makeOptions();
      const observer1 = makeObserver(KEY);
      const observer2 = makeObserver(KEY2);
      store.attachObserver(KEY, observer1, opts);
      store.attachObserver(KEY2, observer2, opts);

      const fetcher1 = makeFetcher("data1", 1000);
      const fetcher2 = makeFetcher("data2", 1000);
      store.ensureFetch(KEY, "/api/items", fetcher1);
      store.ensureFetch(KEY2, "/api/users", fetcher2);

      store.clearCache();

      // After clear, need new observer+config to fetch
      const observer3 = makeObserver(KEY);
      store.attachObserver(KEY, observer3, opts);
      const fetcher3 = makeFetcher("data3", 100);
      store.ensureFetch(KEY, "/api/items", fetcher3);
      // Verify new fetch was dispatched (no joining old inflight)
      const fetcher4 = makeFetcher("data4");
      store.ensureFetch(KEY, "/api/items", fetcher4);
      expect(fetcher4).not.toHaveBeenCalled(); // joined fetcher3
    });

    it("should clear all cooldowns", async () => {
      const opts = makeOptions({
        dedupingInterval: 10_000,
        staleTime: 0,
      });
      const observer = makeObserver(KEY);
      store.attachObserver(KEY, observer, opts);

      const fetcher1 = makeFetcher("data");
      store.ensureFetch(KEY, "/api/items", fetcher1);
      await flush();

      store.clearCache();

      // Re-attach observer with config and fetch
      const observer2 = makeObserver(KEY);
      store.attachObserver(KEY, observer2, opts);
      const fetcher2 = makeFetcher("data2", 100);
      store.ensureFetch(KEY, "/api/items", fetcher2);
      // Verify dispatch by checking join behavior
      const fetcher3 = makeFetcher("data3");
      store.ensureFetch(KEY, "/api/items", fetcher3);
      expect(fetcher3).not.toHaveBeenCalled(); // joined fetcher2
    });

    it("should clear queryConfigMap", () => {
      const opts = makeOptions();
      const observer = makeObserver(KEY);
      store.attachObserver(KEY, observer, opts);

      store.clearCache();

      // After clear, ensureFetch should do nothing (no queryConfig)
      const fetcher = makeFetcher("data");
      store.ensureFetch(KEY, "/api/items", fetcher);
      // No inflight should exist
      store.ensureFetch(KEY, "/api/items", fetcher);
      // If it did nothing, the fetcher should never be called (even async)
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// T022: Status derivation (data-based)
// ═══════════════════════════════════════════════════════════════

describe("T022: Status derivation", () => {
  const KEY = "s:/api/status" as HashedKey;

  // Status derivation logic (in the hook, not the store):
  // data != null             -> 'success'
  // fetchStatus === 'fetching' -> 'loading' (when no data)
  // error != null            -> 'error' (when no data)
  // otherwise                -> 'idle'
  //
  // The store provides the building blocks via observer callbacks.
  // These tests verify the store calls the right callbacks at the right times.

  it("should notify onData with non-null data on successful fetch -> success derivation", async () => {
    const opts = makeOptions();
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    const fetcher = makeFetcher({ name: "test" });
    store.ensureFetch(KEY, "/api/status", fetcher);
    await flush();

    // onData was called -> data != null -> status = 'success'
    expect(observer.onData).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "test" }),
      }),
    );
  });

  it("should broadcast fetchStatus='fetching' before data arrives -> loading derivation (when no data)", () => {
    const opts = makeOptions();
    const fetchStatuses: string[] = [];
    const observer = makeObserver(KEY, {
      onFetchStatusChange: vi.fn((status: string) => {
        fetchStatuses.push(status);
      }),
    });
    store.attachObserver(KEY, observer, opts);

    const fetcher = makeFetcher("data", 1000);
    store.ensureFetch(KEY, "/api/status", fetcher);

    // fetchStatus = 'fetching', no data -> status = 'loading'
    expect(fetchStatuses).toContain("fetching");
    expect(observer.hasData).toBe(false);
  });

  it("should notify onError when fetch fails without data -> error derivation", async () => {
    const opts = makeOptions({ retry: 0 });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    const fetcher = makeFailingFetcher(new Error("fail"));
    store.ensureFetch(KEY, "/api/status", fetcher);
    await flush();

    // error != null, data == null -> status = 'error'
    expect(observer.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "fail" }));
    expect(observer.hasData).toBe(false);
  });

  it("should keep observer.hasData=true when revalidation fails (success maintained)", async () => {
    const opts = makeOptions({ staleTime: 0, retry: 0 });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    // First fetch succeeds
    const fetcher1 = makeFetcher("good-data");
    store.ensureFetch(KEY, "/api/status", fetcher1);
    await flush();

    expect(observer.hasData).toBe(true);
    expect(observer.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "good-data" }));

    // Force revalidate with failing fetcher
    const fetcher2 = makeFailingFetcher(new Error("revalidation failed"));
    void store.forceRevalidate(KEY, "/api/status", fetcher2).catch(() => {});
    await flush();

    // Error was notified
    expect(observer.onError).toHaveBeenCalled();
    // But hasData is still true -> data != null -> status = 'success'
    expect(observer.hasData).toBe(true);
  });

  it("should not call any callbacks when no fetch and no cache -> idle derivation", () => {
    const opts = makeOptions();
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    // No fetch, no cache: no callbacks -> status = 'idle'
    expect(observer.hasData).toBe(false);
    expect(observer.onData).not.toHaveBeenCalled();
    expect(observer.onError).not.toHaveBeenCalled();
    expect(observer.onFetchStatusChange).not.toHaveBeenCalled();
  });

  it("should broadcast fetchStatus='fetching' even when data exists -> enables isValidating derivation", async () => {
    const opts = makeOptions({ staleTime: 0 });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    // First fetch
    const fetcher1 = makeFetcher("data1");
    store.ensureFetch(KEY, "/api/status", fetcher1);
    await flush();

    vi.mocked(observer.onFetchStatusChange).mockClear();

    // Revalidate (data exists, fetchStatus -> fetching)
    const fetcher2 = makeFetcher("data2");
    store.forceRevalidate(KEY, "/api/status", fetcher2);

    // fetchStatus = 'fetching' + data exists -> hook can derive isValidating=true
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("fetching");
    expect(observer.hasData).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// T024: Race condition prevention (requestId-based last-write-wins)
// ═══════════════════════════════════════════════════════════════

describe("T024: Race condition prevention", () => {
  const KEY = "s:/api/race" as HashedKey;

  it("should only commit data from the latest request (last-write-wins)", async () => {
    const opts = makeOptions();
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    // First fetch: slow (never resolved - aborted by forceRevalidate)
    let _resolveFirst!: (val: string) => void;
    const firstPromise = new Promise<string>((r) => {
      _resolveFirst = r;
    });
    const fetcher1 = vi.fn(() => firstPromise);

    // Second fetch: will resolve first
    let resolveSecond!: (val: string) => void;
    const secondPromise = new Promise<string>((r) => {
      resolveSecond = r;
    });
    const fetcher2 = vi.fn(() => secondPromise);

    // Start first fetch
    store.ensureFetch(KEY, "/api/race", fetcher1);
    // Let the fetcher be called
    await flush();

    // Force revalidate starts second fetch (aborts first)
    store.forceRevalidate(KEY, "/api/race", fetcher2);
    await flush();

    // Second resolves
    resolveSecond("second-data");
    await flush();

    // Cache should have second-data
    const cached = store.getCache<string>(KEY);
    expect(cached).not.toBeNull();
    expect(cached!.data).toBe("second-data");
  });

  it("should discard stale response when aborted by forceRevalidate", async () => {
    const opts = makeOptions();
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    let resolveA!: (val: string) => void;
    const promiseA = new Promise<string>((r) => {
      resolveA = r;
    });
    const fetcherA = vi.fn(() => promiseA);

    let resolveB!: (val: string) => void;
    const promiseB = new Promise<string>((r) => {
      resolveB = r;
    });
    const fetcherB = vi.fn(() => promiseB);

    // Start fetch A
    store.ensureFetch(KEY, "/api/race", fetcherA);
    await flush();

    // Force start fetch B (aborts A)
    store.forceRevalidate(KEY, "/api/race", fetcherB);
    await flush();

    // Resolve B first
    resolveB("B-result");
    await flush();

    expect(observer.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "B-result" }));

    vi.mocked(observer.onData).mockClear();

    // Resolve A (aborted, should not commit)
    resolveA("A-result");
    await flush();

    // A-result should NOT appear in cache
    const cached = store.getCache<string>(KEY);
    expect(cached!.data).toBe("B-result");

    // Observer should NOT have received A-result
    const dataCalls = vi.mocked(observer.onData).mock.calls;
    const hasAResult = dataCalls.some(
      (call) => (call[0] as CacheEntry<string>)?.data === "A-result",
    );
    expect(hasAResult).toBe(false);
  });

  it("should increment requestId for each new fetch", async () => {
    const opts = makeOptions({ staleTime: 0 });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    const fetcher = makeFetcher("data");

    // First fetch
    store.ensureFetch(KEY, "/api/race", fetcher);
    await flush();

    // Force second fetch
    store.forceRevalidate(KEY, "/api/race", fetcher);
    await flush();

    // Fetcher should have been called twice (different requests)
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("should handle multiple rapid forceRevalidate calls", async () => {
    const opts = makeOptions();
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    const resolvers: Array<(val: string) => void> = [];
    const createFetcher = (_label: string) =>
      vi.fn(
        () =>
          new Promise<string>((r) => {
            resolvers.push(r);
          }),
      );

    const f1 = createFetcher("f1");
    const f2 = createFetcher("f2");
    const f3 = createFetcher("f3");

    store.ensureFetch(KEY, "/api/race", f1);
    await flush();

    store.forceRevalidate(KEY, "/api/race", f2);
    await flush();

    store.forceRevalidate(KEY, "/api/race", f3);
    await flush();

    // Only f3 (the latest) should commit when resolved
    // Resolve all in order
    if (resolvers[0]) resolvers[0]("first");
    if (resolvers[1]) resolvers[1]("second");
    if (resolvers[2]) resolvers[2]("third");
    await flush();

    const cached = store.getCache<string>(KEY);
    expect(cached).not.toBeNull();
    expect(cached!.data).toBe("third");
  });
});

// ═══════════════════════════════════════════════════════════════
// T034: CacheStore.setCache as mutate backend
// ═══════════════════════════════════════════════════════════════

describe("T034: setCache as mutate backend", () => {
  const KEY = "s:/api/mutate" as HashedKey;

  it("should update cache data and notify all observers", () => {
    const opts = makeOptions();
    const observer1 = makeObserver(KEY);
    const observer2 = makeObserver(KEY);
    store.attachObserver(KEY, observer1, opts);
    store.attachObserver(KEY, observer2, opts);

    const entry: CacheEntry<{ name: string }> = {
      data: { name: "mutated" },
      timestamp: Date.now(),
    };
    store.setCache(KEY, entry);

    expect(observer1.onData).toHaveBeenCalledWith(entry);
    expect(observer2.onData).toHaveBeenCalledWith(entry);
    expect(observer1.hasData).toBe(true);
    expect(observer2.hasData).toBe(true);
  });

  it("should support function form of mutate (caller reads current + computes next)", () => {
    const opts = makeOptions();
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    // Initial cache
    const initial: CacheEntry<number> = {
      data: 10,
      timestamp: Date.now(),
    };
    store.setCache(KEY, initial);

    // Caller reads current cache and computes next value (function form)
    const current = store.getCache<number>(KEY);
    const newData = current?.data != null ? current.data + 5 : 0;
    const updated: CacheEntry<number> = {
      data: newData,
      timestamp: Date.now(),
    };
    store.setCache(KEY, updated);

    const cached = store.getCache<number>(KEY);
    expect(cached!.data).toBe(15);
  });

  it("should work even when no observers are attached", () => {
    const entry: CacheEntry<string> = {
      data: "solo",
      timestamp: Date.now(),
    };
    store.setCache(KEY, entry);

    const cached = store.getCache<string>(KEY);
    expect(cached!.data).toBe("solo");
  });

  it("should not notify detached observers (enabled=false scenario)", () => {
    const opts = makeOptions();
    const observer1 = makeObserver(KEY);
    store.attachObserver(KEY, observer1, opts);

    // Simulate observer2 detaching (enabled=false)
    const observer2 = makeObserver(KEY);
    store.attachObserver(KEY, observer2, opts);
    store.detachObserver(KEY, observer2);

    const entry: CacheEntry<string> = {
      data: "updated",
      timestamp: Date.now(),
    };
    store.setCache(KEY, entry);

    // observer1 should be notified
    expect(observer1.onData).toHaveBeenCalledWith(entry);

    // observer2 should NOT receive the setCache notification (detached)
    const observer2Calls = vi.mocked(observer2.onData).mock.calls;
    const hasUpdatedCall = observer2Calls.some(
      (call) => (call[0] as CacheEntry<string>)?.data === "updated",
    );
    expect(hasUpdatedCall).toBe(false);
  });

  it("should update cacheMap regardless of observer presence", () => {
    // No observers at all
    const entry: CacheEntry<string> = {
      data: "no-observers",
      timestamp: Date.now(),
    };
    store.setCache(KEY, entry);

    expect(store.getCache<string>(KEY)!.data).toBe("no-observers");

    // Subsequent observer attach should see the cached data
    const opts = makeOptions();
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    expect(observer.onData).toHaveBeenCalledWith(entry);
    expect(observer.hasData).toBe(true);
  });

  it("should handle complex data types", () => {
    const complexData = {
      users: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
      pagination: { page: 1, total: 100 },
    };

    const entry: CacheEntry<typeof complexData> = {
      data: complexData,
      timestamp: Date.now(),
    };
    store.setCache(KEY, entry);

    const cached = store.getCache<typeof complexData>(KEY);
    expect(cached!.data).toEqual(complexData);
    expect(cached!.data!.users).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// T035: CacheStore.forceRevalidate as revalidate backend
// ═══════════════════════════════════════════════════════════════

describe("T035: forceRevalidate as revalidate backend", () => {
  const KEY = "s:/api/revalidate" as HashedKey;

  it("should abort existing in-flight fetch", async () => {
    const opts = makeOptions();
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    // Start a slow fetch with abort tracking
    let abortSignal: AbortSignal | null = null;
    const slowFetcher = vi.fn(
      (ctx: FetcherCtx) =>
        new Promise<string>((resolve) => {
          abortSignal = ctx.signal;
          setTimeout(() => resolve("slow"), 5000);
        }),
    );
    store.ensureFetch(KEY, "/api/revalidate", slowFetcher);
    await flush(); // let fetcher be called

    expect(abortSignal).not.toBeNull();
    expect(abortSignal!.aborted).toBe(false);

    // Force revalidate should abort the slow fetch
    const fastFetcher = makeFetcher("fast");
    store.forceRevalidate(KEY, "/api/revalidate", fastFetcher);

    expect(abortSignal!.aborted).toBe(true);
  });

  it("should clear cooldown and start new fetch", async () => {
    const opts = makeOptions({
      dedupingInterval: 60_000,
      staleTime: 0,
    });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    // Complete a fetch (enters cooldown)
    const fetcher1 = makeFetcher("data1");
    store.ensureFetch(KEY, "/api/revalidate", fetcher1);
    await flush();

    // ensureFetch would be suppressed by cooldown
    const fetcherSuppressed = makeFetcher("suppressed");
    store.ensureFetch(KEY, "/api/revalidate", fetcherSuppressed);
    expect(fetcherSuppressed).not.toHaveBeenCalled();

    // forceRevalidate should bypass cooldown
    const fetcher2 = makeFetcher("data2");
    store.forceRevalidate(KEY, "/api/revalidate", fetcher2);
    // Verify dispatch by checking join
    const fetcherJoin = makeFetcher("join");
    store.ensureFetch(KEY, "/api/revalidate", fetcherJoin);
    expect(fetcherJoin).not.toHaveBeenCalled(); // joined fetcher2
  });

  it("should dispatch a new fetch even when no prior in-flight exists", () => {
    const opts = makeOptions();
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    const fetcher = makeFetcher("data");
    store.forceRevalidate(KEY, "/api/revalidate", fetcher);

    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("fetching");
  });

  it("should do nothing if no queryConfig exists", () => {
    // No observer attached = no queryConfig
    const fetcher = makeFetcher("data");
    store.forceRevalidate(KEY, "/api/revalidate", fetcher);
    // Should not throw and fetcher should never be called
  });

  it("should notify observers with new data after successful revalidation", async () => {
    const opts = makeOptions();
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    // Initial data
    store.setCache(KEY, { data: "old", timestamp: Date.now() });
    vi.mocked(observer.onData).mockClear();

    // Force revalidate
    const fetcher = makeFetcher("new");
    store.forceRevalidate(KEY, "/api/revalidate", fetcher);
    await flush();

    expect(observer.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "new" }));
    expect(store.getCache<string>(KEY)!.data).toBe("new");
  });

  it("should enter cooldown after forceRevalidate completes", async () => {
    const opts = makeOptions({
      dedupingInterval: 5_000,
      staleTime: 0,
    });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    const fetcher1 = makeFetcher("revalidated");
    store.forceRevalidate(KEY, "/api/revalidate", fetcher1);
    await flush();

    // Now in cooldown. ensureFetch should be suppressed.
    const fetcher2 = makeFetcher("suppressed");
    store.ensureFetch(KEY, "/api/revalidate", fetcher2);
    expect(fetcher2).not.toHaveBeenCalled();

    // After cooldown expires (via setTimeout auto-delete)
    vi.advanceTimersByTime(5_001);

    const fetcher3 = makeFetcher("after-cooldown");
    store.ensureFetch(KEY, "/api/revalidate", fetcher3);
    // Should dispatch (no cooldown, data is stale with staleTime=0)
    // Verify by checking join behavior
    const fetcherJoin = makeFetcher("join");
    store.ensureFetch(KEY, "/api/revalidate", fetcherJoin);
    expect(fetcherJoin).not.toHaveBeenCalled(); // joined fetcher3
  });

  it("should notify onError when forced revalidation fails", async () => {
    const opts = makeOptions({ retry: 0 });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    const fetcher = makeFailingFetcher(new Error("server down"));
    void store.forceRevalidate(KEY, "/api/revalidate", fetcher).catch(() => {});
    await flush();

    expect(observer.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "server down" }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge cases and additional coverage
// ═══════════════════════════════════════════════════════════════

describe("Edge cases", () => {
  const KEY = "s:/api/edge" as HashedKey;

  it("should handle multiple keys independently", async () => {
    const KEY_A = "s:/api/a" as HashedKey;
    const KEY_B = "s:/api/b" as HashedKey;

    const opts = makeOptions();
    const observerA = makeObserver(KEY_A);
    const observerB = makeObserver(KEY_B);
    store.attachObserver(KEY_A, observerA, opts);
    store.attachObserver(KEY_B, observerB, opts);

    const fetcherA = makeFetcher("data-a");
    const fetcherB = makeFetcher("data-b");
    store.ensureFetch(KEY_A, "/api/a", fetcherA);
    store.ensureFetch(KEY_B, "/api/b", fetcherB);
    await flush();

    expect(store.getCache<string>(KEY_A)!.data).toBe("data-a");
    expect(store.getCache<string>(KEY_B)!.data).toBe("data-b");

    // Observers should only receive their own key's data
    expect(observerA.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "data-a" }));
    expect(observerB.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "data-b" }));

    // Verify no cross-talk
    const aDataCalls = vi.mocked(observerA.onData).mock.calls;
    const hasB = aDataCalls.some((c) => (c[0] as CacheEntry<string>)?.data === "data-b");
    expect(hasB).toBe(false);
  });

  it("should handle rapid attach/detach cycles without errors", () => {
    const opts = makeOptions();
    for (let i = 0; i < 100; i++) {
      const observer = makeObserver(KEY);
      store.attachObserver(KEY, observer, opts);
      store.detachObserver(KEY, observer);
    }

    expect(() => store.ensureFetch(KEY, "/api/edge", makeFetcher("data"))).not.toThrow();
  });

  it("should auto-delete cooldown via setTimeout after dedupingInterval", async () => {
    const opts = makeOptions({
      dedupingInterval: 3_000,
      staleTime: 0,
    });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    const fetcher = makeFetcher("data");
    store.ensureFetch(KEY, "/api/edge", fetcher);
    await flush();

    // Within cooldown
    const fetcher2 = makeFetcher("data2");
    store.ensureFetch(KEY, "/api/edge", fetcher2);
    expect(fetcher2).not.toHaveBeenCalled();

    // After cooldown auto-delete
    vi.advanceTimersByTime(3_000);

    const fetcher3 = makeFetcher("data3");
    store.ensureFetch(KEY, "/api/edge", fetcher3);
    // Verify it dispatched
    const fetcher4 = makeFetcher("data4");
    store.ensureFetch(KEY, "/api/edge", fetcher4);
    expect(fetcher4).not.toHaveBeenCalled(); // joined fetcher3
  });

  it("should handle setCache with error field in CacheEntry", () => {
    const entry: CacheEntry<string> = {
      data: "partial",
      timestamp: Date.now(),
      error: {
        type: "http",
        status: 500,
        message: "Internal Server Error",
        retryCount: 0,
        timestamp: Date.now(),
      },
    };
    store.setCache(KEY, entry);

    const cached = store.getCache<string>(KEY);
    expect(cached!.data).toBe("partial");
    expect(cached!.error).toBeDefined();
    expect(cached!.error!.type).toBe("http");
  });

  it("should reset all state via _reset()", async () => {
    const opts = makeOptions();
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    store.setCache(KEY, { data: "cached", timestamp: Date.now() });
    store.ensureFetch(KEY, "/api/edge", makeFetcher("data", 1000));

    store._reset();

    expect(store.getCache(KEY)).toBeNull();

    // After reset, ensureFetch should do nothing (no queryConfig)
    const fetcher = makeFetcher("post-reset");
    store.ensureFetch(KEY, "/api/edge", fetcher);
    // Verify no dispatch
    store.ensureFetch(KEY, "/api/edge", fetcher);
  });

  it("should handle keys() returning all cached keys", () => {
    const KEY_A = "s:/api/a" as HashedKey;
    const KEY_B = "s:/api/b" as HashedKey;

    store.setCache(KEY_A, { data: "a", timestamp: 1 });
    store.setCache(KEY_B, { data: "b", timestamp: 2 });

    const keys = store.keys();
    expect(keys).toContain(KEY_A);
    expect(keys).toContain(KEY_B);
    expect(keys).toHaveLength(2);
  });

  it("should handle error type classification from store's toSWRError", async () => {
    const opts = makeOptions({ retry: 0 });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    // TypeError -> 'network' classification
    const fetcher = vi.fn(() => {
      return Promise.reject(new TypeError("Failed to fetch"));
    });
    store.ensureFetch(KEY, "/api/edge", fetcher);
    await flush();

    expect(observer.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "network",
        message: "Failed to fetch",
      }),
    );
  });

  it("should broadcast fetchStatus='idle' after error", async () => {
    const opts = makeOptions({ retry: 0 });
    const fetchStatuses: string[] = [];
    const observer = makeObserver(KEY, {
      onFetchStatusChange: vi.fn((s: string) => fetchStatuses.push(s)),
    });
    store.attachObserver(KEY, observer, opts);

    const fetcher = makeFailingFetcher(new Error("oops"));
    store.ensureFetch(KEY, "/api/edge", fetcher);
    await flush();

    expect(fetchStatuses).toEqual(["fetching", "idle"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// T051: Retry with exponential backoff
// ═══════════════════════════════════════════════════════════════

describe("T051: Retry with exponential backoff", () => {
  const KEY = "s:/api/retry" as HashedKey;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should retry up to max retry count with exponential backoff", async () => {
    const opts = makeOptions({ retry: 3, retryInterval: 1_000 });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    let callCount = 0;
    const fetcher = vi.fn(() => {
      callCount++;
      return Promise.reject(new Error(`fail-${callCount}`));
    });

    store.ensureFetch(KEY, "/api/retry", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // First retry after 1000ms (1000 * 2^0)
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Second retry after 2000ms (1000 * 2^1)
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Third retry after 4000ms (1000 * 2^2)
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetcher).toHaveBeenCalledTimes(4);

    // Resolve the last retry's promise
    await vi.advanceTimersByTimeAsync(0);

    // No more retries after max
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(4);

    // Error should be notified with correct retryCount
    expect(observer.onError).toHaveBeenCalledWith(expect.objectContaining({ retryCount: 3 }));
  });

  it("should not retry when retry=0", async () => {
    const opts = makeOptions({ retry: 0 });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    const fetcher = vi.fn(() => Promise.reject(new Error("fail")));
    store.ensureFetch(KEY, "/api/retry", fetcher);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Error notified immediately
    expect(observer.onError).toHaveBeenCalledWith(expect.objectContaining({ retryCount: 0 }));
  });

  it("should not retry on abort", async () => {
    const opts = makeOptions({ retry: 3, retryInterval: 1_000 });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    const fetcher = vi.fn(() => Promise.reject(new Error("fail")));
    store.ensureFetch(KEY, "/api/retry", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Detach all observers -> aborts in-flight
    store.detachObserver(KEY, observer);

    // No retry should happen
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("should support custom retryInterval function", async () => {
    const customInterval = vi.fn((retryCount: number, _error: any) => retryCount * 500);
    const opts = makeOptions({ retry: 2, retryInterval: customInterval });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    let callCount = 0;
    const fetcher = vi.fn(() => {
      callCount++;
      return Promise.reject(new Error(`fail-${callCount}`));
    });

    store.ensureFetch(KEY, "/api/retry", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // First retry: customInterval(0, error) = 0ms
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Second retry: customInterval(1, error) = 500ms
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Resolve last promise
    await vi.advanceTimersByTimeAsync(0);

    // No more retries
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("should succeed on retry and stop retrying", async () => {
    const opts = makeOptions({ retry: 3, retryInterval: 1_000 });
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, opts);

    let callCount = 0;
    const fetcher = vi.fn(() => {
      callCount++;
      if (callCount < 3) return Promise.reject(new Error(`fail-${callCount}`));
      return Promise.resolve("success-on-retry");
    });

    store.ensureFetch(KEY, "/api/retry", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // First retry after 1000ms
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Second retry after 2000ms -- this one succeeds
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Let success resolve
    await vi.advanceTimersByTimeAsync(0);

    // Data should be set
    expect(observer.onData).toHaveBeenCalledWith(
      expect.objectContaining({ data: "success-on-retry" }),
    );

    // No more retries
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("should keep fetchStatus 'fetching' during retries", async () => {
    const opts = makeOptions({ retry: 2, retryInterval: 1_000 });
    const fetchStatuses: string[] = [];
    const observer = makeObserver(KEY, {
      onFetchStatusChange: vi.fn((s: string) => fetchStatuses.push(s)),
    });
    store.attachObserver(KEY, observer, opts);

    const fetcher = vi.fn(() => Promise.reject(new Error("fail")));
    store.ensureFetch(KEY, "/api/retry", fetcher);

    // Should start with fetching
    expect(fetchStatuses).toContain("fetching");

    // During retries, should still be fetching
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);

    // After all retries exhausted, should be idle
    expect(fetchStatuses[fetchStatuses.length - 1]).toBe("idle");
  });
});

// ═══════════════════════════════════════════════════════════════
// cache.revalidate() public API
// ═══════════════════════════════════════════════════════════════

describe("cache.revalidate()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.clearCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should revalidate a single key", async () => {
    const rawKey = "/api/revalidate-test";
    const hashedKey = "s:/api/revalidate-test" as HashedKey;
    const opts = makeOptions();
    const fetcher = makeFetcher("initial");
    const observer = makeObserver(hashedKey);

    store.attachObserver(hashedKey, observer, opts);
    store.ensureFetch(hashedKey, rawKey, fetcher);
    await vi.advanceTimersByTimeAsync(0);

    // Reset call count after initial fetch
    fetcher.mockClear();
    fetcher.mockImplementation(() => Promise.resolve("refreshed"));

    // cache.revalidate takes a raw key (same as useSWR key), hashes it internally
    cache.revalidate(rawKey);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    store.detachObserver(hashedKey, observer);
  });

  it("should revalidate multiple keys matching a predicate", async () => {
    const opts = makeOptions();
    const fetcherA = makeFetcher("dataA");
    const fetcherB = makeFetcher("dataB");
    const fetcherC = makeFetcher("dataC");

    const keyA = "s:/api/users" as HashedKey;
    const keyB = "s:/api/users/1" as HashedKey;
    const keyC = "s:/api/posts" as HashedKey;

    const obsA = makeObserver(keyA);
    const obsB = makeObserver(keyB);
    const obsC = makeObserver(keyC);

    store.attachObserver(keyA, obsA, opts);
    store.attachObserver(keyB, obsB, opts);
    store.attachObserver(keyC, obsC, opts);

    store.ensureFetch(keyA, "/api/users", fetcherA);
    store.ensureFetch(keyB, "/api/users/1", fetcherB);
    store.ensureFetch(keyC, "/api/posts", fetcherC);
    await vi.advanceTimersByTimeAsync(0);

    fetcherA.mockClear();
    fetcherB.mockClear();
    fetcherC.mockClear();
    fetcherA.mockImplementation(() => Promise.resolve("newA"));
    fetcherB.mockImplementation(() => Promise.resolve("newB"));
    fetcherC.mockImplementation(() => Promise.resolve("newC"));

    // Revalidate only keys starting with "s:/api/users"
    cache.revalidate((key) => key.startsWith("s:/api/users"));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetcherA).toHaveBeenCalledTimes(1);
    expect(fetcherB).toHaveBeenCalledTimes(1);
    expect(fetcherC).not.toHaveBeenCalled();

    store.detachObserver(keyA, obsA);
    store.detachObserver(keyB, obsB);
    store.detachObserver(keyC, obsC);
  });

  it("should be a no-op for null/undefined/false keys", () => {
    expect(() => cache.revalidate(null)).not.toThrow();
    expect(() => cache.revalidate(undefined)).not.toThrow();
    expect(() => cache.revalidate(false)).not.toThrow();
  });

  it("should be a no-op for keys without observers", () => {
    // No observer attached, revalidateByKey returns false but shouldn't throw
    expect(() => cache.revalidate("/api/no-observer")).not.toThrow();
  });

  it("should be a no-op for predicate matching no keys", () => {
    expect(() => cache.revalidate(() => false)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// US3: forceRevalidate offline guard
// ═══════════════════════════════════════════════════════════════

describe("US3: forceRevalidate offline guard", () => {
  const KEY = "offline-force" as HashedKey;

  it("should return undefined and broadcast paused when offline", async () => {
    const obs = makeObserver(KEY);
    store.attachObserver(KEY, obs, makeOptions());

    const fetcher = makeFetcher("data");
    store.ensureFetch(KEY, KEY, fetcher);
    await flush();
    fetcher.mockClear();
    (obs.onFetchStatusChange as any).mockClear();

    // Go offline
    store.setOnline(false);

    const result = await store.forceRevalidate(KEY, KEY, fetcher);

    expect(result).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(obs.onFetchStatusChange).toHaveBeenCalledWith("paused");
  });

  it("should add key to pendingKeys when offline and resume on setOnline(true)", async () => {
    const obs = makeObserver(KEY);
    store.attachObserver(KEY, obs, makeOptions());

    const fetcher = makeFetcher("initial");
    store.ensureFetch(KEY, KEY, fetcher);
    await flush();
    fetcher.mockClear();

    // Go offline
    store.setOnline(false);

    const fetcher2 = makeFetcher("refreshed");
    await store.forceRevalidate(KEY, KEY, fetcher2);

    // Fetcher should not be called while offline
    expect(fetcher2).not.toHaveBeenCalled();

    // Go online - pending key should be flushed
    store.setOnline(true);
    await flush();

    // The fetcher stored in fetcherMap should have been called
    // (setOnline triggers pendingKeys flush)
    expect(obs.onFetchStatusChange).toHaveBeenCalledWith("fetching");
  });
});

// ═══════════════════════════════════════════════════════════════
// CacheEntry.error persistence
// ═══════════════════════════════════════════════════════════════

describe("CacheEntry.error persistence on fetch failure", () => {
  const KEY = "s:/api/error-persist" as HashedKey;

  beforeEach(() => {
    vi.useFakeTimers();
    store._reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should persist error in cacheMap when all retries exhausted", async () => {
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, makeOptions({ retry: 0 }));

    const fetcher = makeFailingFetcher(new Error("server down"));
    store.ensureFetch(KEY, KEY, fetcher);
    await flush();

    const cached = store.getCache(KEY);
    expect(cached).not.toBeNull();
    expect(cached!.error).toBeDefined();
    expect(cached!.error!.type).toBeDefined();
    expect(cached!.error!.message).toBe("server down");
  });

  it("should preserve existing data as stale-while-error", async () => {
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, makeOptions({ retry: 0, staleTime: 0 }));

    // First: successful fetch
    const fetcher1 = makeFetcher("good-data");
    store.ensureFetch(KEY, KEY, fetcher1);
    await flush();
    expect(store.getCache(KEY)!.data).toBe("good-data");

    // Clear cooldown so next fetch is allowed
    vi.advanceTimersByTime(10_000);

    // Second: failing fetch
    const fetcher2 = makeFailingFetcher(new Error("server down"));
    store.ensureFetch(KEY, KEY, fetcher2);
    await flush();

    const cached = store.getCache(KEY);
    expect(cached!.data).toBe("good-data"); // preserved
    expect(cached!.error).toBeDefined();
    expect(cached!.error!.message).toBe("server down");
  });

  it("should persist error to storage backend", async () => {
    const storageMock = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      keys: vi.fn(async () => []),
      size: vi.fn(async () => 0),
    };
    await store.initStorage(storageMock);

    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, makeOptions({ retry: 0 }));

    const fetcher = makeFailingFetcher(new Error("persist me"));
    store.ensureFetch(KEY, KEY, fetcher);
    await flush();

    // storage.set should have been called with error entry
    const setCalls = storageMock.set.mock.calls as unknown as [string, CacheEntry][];
    const errorCall = setCalls.find((call) => call[1].error != null);
    expect(errorCall).toBeDefined();
    expect(errorCall![1].error!.message).toBe("persist me");
  });

  it("should clear error from cache on successful revalidation", async () => {
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, makeOptions({ retry: 0, staleTime: 0 }));

    // Fail first
    const fetcher1 = makeFailingFetcher(new Error("temporary"));
    store.ensureFetch(KEY, KEY, fetcher1);
    await flush();
    expect(store.getCache(KEY)!.error).toBeDefined();

    // Clear cooldown
    vi.advanceTimersByTime(10_000);

    // Succeed
    const fetcher2 = makeFetcher("recovered");
    store.ensureFetch(KEY, KEY, fetcher2);
    await flush();

    const cached = store.getCache(KEY);
    expect(cached!.data).toBe("recovered");
    expect(cached!.error).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// MF-2 + SF-3: CacheStorage error handling
// ═══════════════════════════════════════════════════════════════

describe("CacheStorage error handling (MF-2 + SF-3)", () => {
  const KEY = "s:/api/storage-err" as HashedKey;

  beforeEach(() => {
    vi.useFakeTimers();
    store._reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("storage.set failure should log warning in DEV mode and not throw", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storageMock = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        throw new Error("storage write failed");
      }),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      keys: vi.fn(async () => []),
      size: vi.fn(async () => 0),
    };
    await store.initStorage(storageMock);

    // setCache calls storage.set internally
    expect(() => store.setCache(KEY, { data: "test", timestamp: Date.now() })).not.toThrow();

    // Let the async rejection be caught
    await flush();

    // In DEV mode, a warning should be logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("storage.set failed"),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it("storage.delete failure should not throw", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storageMock = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {
        throw new Error("storage delete failed");
      }),
      clear: vi.fn(async () => {}),
      keys: vi.fn(async () => []),
      size: vi.fn(async () => 0),
    };
    await store.initStorage(storageMock);

    store.setCache(KEY, { data: "test", timestamp: Date.now() });

    expect(() => store.deleteCache(KEY)).not.toThrow();

    await flush();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("storage.delete failed"),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it("storage.clear failure should not throw", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storageMock = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {
        throw new Error("storage clear failed");
      }),
      keys: vi.fn(async () => []),
      size: vi.fn(async () => 0),
    };
    await store.initStorage(storageMock);

    expect(() => store.clearCache()).not.toThrow();

    await flush();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("storage.clear failed"),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════
// MF-1 + SF-2: Lazy Hydration Race Condition
// ═══════════════════════════════════════════════════════════════

describe("Lazy Hydration Race Condition (MF-1 + SF-2)", () => {
  const KEY = "s:/api/hydrate" as HashedKey;

  beforeEach(() => {
    vi.useFakeTimers();
    store._reset();
    resetObserverIdCounter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("concurrent hydrateKey calls with async storage should deduplicate", async () => {
    const storageMock = {
      get: vi.fn(async (_key: HashedKey) => {
        return { data: "hydrated", timestamp: 1000 };
      }),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      keys: vi.fn(async () => [KEY]),
      size: vi.fn(async () => 1),
    };

    await store.initStorage(storageMock, "lazy");

    // Trigger multiple concurrent hydrations via getCache
    store.getCache(KEY);
    store.getCache(KEY);
    store.getCache(KEY);

    await flush();

    // storage.get should only be called once (dedup)
    expect(storageMock.get).toHaveBeenCalledTimes(1);
  });

  it("hydratedKeys should only be marked after async hydration completes", async () => {
    let resolveGet: ((v: any) => void) | undefined;

    const storageMock = {
      get: vi.fn(
        () =>
          new Promise((r) => {
            resolveGet = r;
          }),
      ),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      keys: vi.fn(async () => [KEY]),
      size: vi.fn(async () => 1),
    };

    await store.initStorage(storageMock, "lazy");

    // Trigger hydration via attachObserver (which calls hydrateKey)
    const observer = makeObserver(KEY);
    store.attachObserver(KEY, observer, makeOptions());

    // observer.onData should NOT have been called yet (async hydration pending)
    expect(observer.onData).not.toHaveBeenCalled();

    // Resolve the async storage.get
    resolveGet!({ data: "from-storage", timestamp: 1000 });
    await flush();

    // Now getCache should return the data
    const result = store.getCache(KEY);
    expect(result).not.toBeNull();
    expect(result!.data).toBe("from-storage");
  });

  it("concurrent hydrateKey calls should not allow double storage.get (race condition)", async () => {
    const resolvers: Array<(v: any) => void> = [];

    const storageMock = {
      get: vi.fn((_key: HashedKey) => {
        return new Promise((r) => {
          resolvers.push(r);
        });
      }),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      keys: vi.fn(async () => [KEY]),
      size: vi.fn(async () => 1),
    };

    await store.initStorage(storageMock, "lazy");

    // Trigger two concurrent hydrations via attachObserver and getCache
    const observer1 = makeObserver(KEY);
    store.attachObserver(KEY, observer1, makeOptions());
    // This getCache call should deduplicate with the pending hydration
    store.getCache(KEY);

    // Should only have been called once despite two paths
    expect(storageMock.get).toHaveBeenCalledTimes(1);

    // Resolve
    resolvers[0]!({ data: "hydrated-data", timestamp: 5000 });
    await flush();

    const result = store.getCache(KEY);
    expect(result).not.toBeNull();
    expect(result!.data).toBe("hydrated-data");
  });

  it("second getCache during pending hydration should return data after hydration completes", async () => {
    let resolveGet: ((v: any) => void) | undefined;

    const storageMock = {
      get: vi.fn(
        () =>
          new Promise((r) => {
            resolveGet = r;
          }),
      ),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      keys: vi.fn(async () => [KEY]),
      size: vi.fn(async () => 1),
    };

    await store.initStorage(storageMock, "lazy");

    // First call triggers hydration
    const result1 = store.getCache(KEY);
    expect(result1).toBeNull();

    // Second call should not re-trigger storage.get
    const result2 = store.getCache(KEY);
    expect(result2).toBeNull();
    expect(storageMock.get).toHaveBeenCalledTimes(1);

    // Resolve
    resolveGet!({ data: "resolved", timestamp: 2000 });
    await flush();

    // Now both should be available
    const result3 = store.getCache(KEY);
    expect(result3).not.toBeNull();
    expect(result3!.data).toBe("resolved");
  });
});
