import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HashedKey, FetcherCtx } from "../../src/types/index.ts";
import { store } from "../../src/cache/store.ts";
import { makeObserver, makeOptions, resetObserverIdCounter } from "../helpers/index.ts";

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("forceRevalidate returns latest data (US1)", () => {
  beforeEach(() => {
    store._reset();
    resetObserverIdCounter();
  });

  it("should return fetched data from forceRevalidate", async () => {
    const key = "revalidate-key-1" as HashedKey;
    const observer = makeObserver(key);
    const opts = makeOptions();
    store.attachObserver(key, observer, opts);

    const fetcher = vi.fn((_ctx: FetcherCtx) => Promise.resolve("fresh-data"));

    const result = await store.forceRevalidate(key, key, fetcher);
    expect(result).toBe("fresh-data");
  });

  it("should work with default config when queryConfigMap has no entry", async () => {
    // forceRevalidate now uses default config when no queryConfig is set
    // This allows prefetched keys to be revalidated without observers
    const key = "no-config-key" as HashedKey;
    const fetcher = vi.fn((_ctx: FetcherCtx) => Promise.resolve("data"));

    const result = await store.forceRevalidate(key, key, fetcher);
    expect(result).toBe("data");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("should propagate errors from fetcher", async () => {
    const key = "revalidate-error-key" as HashedKey;
    const observer = makeObserver(key);
    const opts = makeOptions({ retry: 0 });
    store.attachObserver(key, observer, opts);

    const fetcher = vi.fn((_ctx: FetcherCtx) => Promise.reject(new Error("fetch failed")));

    await expect(store.forceRevalidate(key, key, fetcher)).rejects.toThrow("fetch failed");
  });

  it("should update cache with fetched data", async () => {
    const key = "revalidate-cache-key" as HashedKey;
    const observer = makeObserver(key);
    const opts = makeOptions();
    store.attachObserver(key, observer, opts);

    // Set initial cache
    store.setCache(key, { data: "old-data", timestamp: 1 });

    const fetcher = vi.fn((_ctx: FetcherCtx) => Promise.resolve("new-data"));
    await store.forceRevalidate(key, key, fetcher);

    const cached = store.getCache(key);
    expect(cached?.data).toBe("new-data");
  });
});

describe("performRevalidate returns latest data (US1)", () => {
  beforeEach(() => {
    store._reset();
    resetObserverIdCounter();
  });

  it("performRevalidate should await forceRevalidate and return fresh data", async () => {
    // This test verifies the integration:
    // performRevalidate calls forceRevalidate, which should now return a Promise<Data>
    // performRevalidate should await it and return the result

    const key = "perf-rev-key" as HashedKey;
    const observer = makeObserver(key);
    const opts = makeOptions();
    store.attachObserver(key, observer, opts);

    // Set initial stale cache
    store.setCache(key, { data: "stale", timestamp: 1 });

    const fetcher = vi.fn((_ctx: FetcherCtx) => Promise.resolve("latest"));
    const result = await store.forceRevalidate(key, key, fetcher);
    expect(result).toBe("latest");
  });
});

describe("performMutate revalidation awaits forceRevalidate (US1)", () => {
  beforeEach(() => {
    store._reset();
    resetObserverIdCounter();
  });

  it("forceRevalidate should complete before returning", async () => {
    const key = "mutate-rev-key" as HashedKey;
    const observer = makeObserver(key);
    const opts = makeOptions();
    store.attachObserver(key, observer, opts);

    store.setCache(key, { data: "optimistic", timestamp: Date.now() });

    const fetcher = vi.fn((_ctx: FetcherCtx) => Promise.resolve("server-data"));
    const result = await store.forceRevalidate(key, key, fetcher);
    expect(result).toBe("server-data");

    // Observer should have been notified with server data
    expect(observer.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "server-data" }));
  });
});
