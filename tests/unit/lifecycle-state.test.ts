import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HashedKey } from "../../src/types/index.ts";
import { store } from "../../src/cache/store.ts";
import { startFetchLifecycle } from "../../src/hooks/lifecycle-state.ts";
import {
  makeObserver,
  makeOptions,
  makeFetcher,
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
// startFetchLifecycle
// ═══════════════════════════════════════════════════════════════

// Helper: create a mock QRL-like object for onSuccess$/onError$
function mockQRL<T extends (...args: any[]) => void>(fn: T) {
  return { resolve: () => Promise.resolve(fn) } as any;
}

describe("startFetchLifecycle", () => {
  const KEY = "s:/api/data" as HashedKey;
  const RAW_KEY = "/api/data";

  it("should attach observer, trigger fetch, and return ActiveLifecycle", async () => {
    const opts = makeOptions({ staleTime: 0, retry: 0, revalidateOn: [] });
    const observer = makeObserver(KEY);
    const fetcher = makeFetcher({ value: 42 });

    const lifecycle = startFetchLifecycle({
      hashedKey: KEY,
      rawKey: RAW_KEY,
      fetcherFn: fetcher,
      observer,
      resolved: opts,
    });

    expect(lifecycle.hashedKey).toBe(KEY);
    expect(lifecycle.rawKey).toBe(RAW_KEY);
    expect(lifecycle.observer).toBe(observer);

    // Fetcher should have been called
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Observer should receive fetching status
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("fetching");

    // Let fetch resolve
    await flush();

    // Observer should receive data
    expect(observer.onData).toHaveBeenCalledWith(
      expect.objectContaining({ data: { value: 42 } }),
    );
  });

  it("should detach observer and clean up on teardown", async () => {
    const opts = makeOptions({ staleTime: 0, retry: 0, revalidateOn: [] });
    const observer = makeObserver(KEY);
    const fetcher = makeFetcher("data");

    const lifecycle = startFetchLifecycle({
      hashedKey: KEY,
      rawKey: RAW_KEY,
      fetcherFn: fetcher,
      observer,
      resolved: opts,
    });

    await flush();

    // Teardown
    lifecycle.teardown();

    // After teardown, setCache should not notify this observer
    (observer.onData as ReturnType<typeof vi.fn>).mockClear();
    store.setCache(KEY, { data: "new-data", timestamp: Date.now() });

    expect(observer.onData).not.toHaveBeenCalled();
  });

  it("should be idempotent on multiple teardown calls", async () => {
    const opts = makeOptions({ staleTime: 0, retry: 0, revalidateOn: [] });
    const observer = makeObserver(KEY);
    const fetcher = makeFetcher("data");

    const lifecycle = startFetchLifecycle({
      hashedKey: KEY,
      rawKey: RAW_KEY,
      fetcherFn: fetcher,
      observer,
      resolved: opts,
    });

    await flush();

    // Multiple teardown calls should not throw
    lifecycle.teardown();
    lifecycle.teardown();
    lifecycle.teardown();
  });

  it("should fire onSuccess$ on cache hit (data already in cache)", async () => {
    // Pre-populate cache
    store.setCache(KEY, { data: { cached: true }, timestamp: Date.now() });

    const onSuccessFn = vi.fn();
    const opts = makeOptions({
      staleTime: 60_000, // fresh data — no revalidation
      retry: 0,
      revalidateOn: [],
      onSuccess$: mockQRL(onSuccessFn),
    });
    const observer = makeObserver(KEY);
    const fetcher = makeFetcher({ value: "fresh" });

    startFetchLifecycle({
      hashedKey: KEY,
      rawKey: RAW_KEY,
      fetcherFn: fetcher,
      observer,
      resolved: opts,
    });

    await flush();

    // onSuccess$ should fire with cached data
    expect(onSuccessFn).toHaveBeenCalledTimes(1);
    expect(onSuccessFn).toHaveBeenCalledWith({ cached: true }, RAW_KEY);

    // No fetch should have occurred (data is fresh)
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should not fire onSuccess$ when cache is empty", async () => {
    const onSuccessFn = vi.fn();
    const opts = makeOptions({
      staleTime: 0,
      retry: 0,
      revalidateOn: [],
      onSuccess$: mockQRL(onSuccessFn),
    });
    const observer = makeObserver(KEY);
    const fetcher = makeFetcher({ value: 42 });

    startFetchLifecycle({
      hashedKey: KEY,
      rawKey: RAW_KEY,
      fetcherFn: fetcher,
      observer,
      resolved: opts,
    });

    await flush();

    // onSuccess$ should fire once from the fetch, not from cache hit
    expect(onSuccessFn).toHaveBeenCalledTimes(1);
    expect(onSuccessFn).toHaveBeenCalledWith({ value: 42 }, RAW_KEY);
  });

  it("should fire onSuccess$ on both cache hit and revalidation when data is stale", async () => {
    // Pre-populate cache with stale data
    store.setCache(KEY, { data: { old: true }, timestamp: Date.now() - 60_000 });

    const onSuccessFn = vi.fn();
    const opts = makeOptions({
      staleTime: 30_000, // data is 60s old, staleTime is 30s → stale
      retry: 0,
      revalidateOn: [],
      onSuccess$: mockQRL(onSuccessFn),
    });
    const observer = makeObserver(KEY);
    const fetcher = makeFetcher({ fresh: true });

    startFetchLifecycle({
      hashedKey: KEY,
      rawKey: RAW_KEY,
      fetcherFn: fetcher,
      observer,
      resolved: opts,
    });

    await flush();

    // onSuccess$ should fire twice: once for cache hit, once for revalidation
    expect(onSuccessFn).toHaveBeenCalledTimes(2);
    expect(onSuccessFn).toHaveBeenNthCalledWith(1, { old: true }, RAW_KEY);
    expect(onSuccessFn).toHaveBeenNthCalledWith(2, { fresh: true }, RAW_KEY);
  });

  it("should register and clean up interval timer", async () => {
    const opts = makeOptions({
      staleTime: 0,
      retry: 0,
      revalidateOn: ["interval"],
      refreshInterval: 5000,
    });
    const observer = makeObserver(KEY);
    const fetcher = makeFetcher("data");

    const lifecycle = startFetchLifecycle({
      hashedKey: KEY,
      rawKey: RAW_KEY,
      fetcherFn: fetcher,
      observer,
      resolved: opts,
    });

    await flush();

    // Initial fetch
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Advance 5 seconds - should trigger interval fetch
    await vi.advanceTimersByTimeAsync(5000);
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(2);

    // Teardown - no more interval fetches
    lifecycle.teardown();
    fetcher.mockClear();

    await vi.advanceTimersByTimeAsync(5000);
    await flush();

    expect(fetcher).not.toHaveBeenCalled();
  });
});
