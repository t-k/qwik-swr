import { describe, it, expect, beforeEach, vi } from "vitest";
import { store } from "../../src/cache/store.ts";
import { cache } from "../../src/cache/cache-api.ts";
import { hashKey } from "../../src/utils/hash.ts";
import type { FetcherCtx, ResolvedSWROptions } from "../../src/types/index.ts";

describe("prefetch integration", () => {
  beforeEach(() => {
    store._reset();
  });

  // T047: prefetch -> cache.get returns data
  describe("T047: prefetch stores data retrievable via cache.get", () => {
    it("should store fetched data in cache after prefetch resolves", async () => {
      const key = "/api/users";
      const data = [{ id: 1, name: "Alice" }];
      const fetcher = (_ctx: FetcherCtx<string>) => Promise.resolve(data);

      const { promise } = cache.prefetch(key, fetcher);
      await promise;

      const entry = cache.get<typeof data>(key);
      expect(entry).not.toBeNull();
      expect(entry!.data).toEqual(data);
      expect(entry!.timestamp).toBeGreaterThan(0);
    });

    it("should work with synchronous fetcher", async () => {
      const key = "/api/config";
      const data = { theme: "dark" };
      const fetcher = (_ctx: FetcherCtx<string>) => data;

      const { promise } = cache.prefetch(key, fetcher);
      await promise;

      const entry = cache.get<typeof data>(key);
      expect(entry).not.toBeNull();
      expect(entry!.data).toEqual(data);
    });

    it("should work with array key", async () => {
      const key = ["users", 42] as const;
      const data = { id: 42, name: "Bob" };
      const fetcher = (_ctx: FetcherCtx<typeof key>) => Promise.resolve(data);

      const { promise } = cache.prefetch(key, fetcher);
      await promise;

      const entry = cache.get<typeof data>(key);
      expect(entry).not.toBeNull();
      expect(entry!.data).toEqual(data);
    });

    it("should pass correct context to fetcher", async () => {
      const key = "/api/items";
      const hashed = hashKey(key);
      const fetcherSpy = vi.fn((_ctx: FetcherCtx<string>) => "result");

      const { promise } = cache.prefetch(key, fetcherSpy);
      await promise;

      expect(fetcherSpy).toHaveBeenCalledOnce();
      const ctx = fetcherSpy.mock.calls[0][0];
      expect(ctx.rawKey).toBe(key);
      expect(ctx.hashedKey).toBe(hashed);
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // T048: abort() cancels the request (data should not be stored)
  describe("T048: abort() cancels prefetch and prevents data storage", () => {
    it("should not store data when abort is called before fetcher resolves", async () => {
      const key = "/api/slow";
      let resolveFetcher!: (value: string) => void;
      const fetcher = (_ctx: FetcherCtx<string>) =>
        new Promise<string>((resolve) => {
          resolveFetcher = resolve;
        });

      const { promise, abort } = cache.prefetch(key, fetcher);

      // Abort before the fetcher resolves
      abort();

      // Now resolve the fetcher (after abort)
      resolveFetcher("should-not-be-stored");
      await promise;

      const entry = cache.get(key);
      expect(entry).toBeNull();
    });

    it("should clean up inflightMap when abort is called before fetcher resolves", async () => {
      const key = "/api/abort-inflight";
      let resolveFetcher!: (value: string) => void;
      const fetcher = (_ctx: FetcherCtx<string>) =>
        new Promise<string>((resolve) => {
          resolveFetcher = resolve;
        });

      const { promise, abort } = cache.prefetch(key, fetcher);

      // Abort before the fetcher resolves
      abort();

      // Resolve the fetcher after abort
      resolveFetcher("should-not-be-stored");
      await promise;

      // inflightMap should be cleaned up.
      // Without force, prefetch deduplicates against inflight entries.
      // If the old entry leaked, the second fetcher would NOT be called.
      const secondFetcher = vi.fn((_ctx: FetcherCtx<string>) => "second-data");
      const { promise: p2 } = cache.prefetch(key, secondFetcher);
      await p2;

      expect(secondFetcher).toHaveBeenCalledOnce();
      expect(cache.get(key)!.data).toBe("second-data");
    });

    it("should not overwrite existing cache when aborted prefetch with force resolves", async () => {
      const key = "/api/data";
      const originalData = { version: 1 };

      // Populate cache first
      const { promise: p1 } = cache.prefetch(key, () => originalData);
      await p1;

      // Start a force prefetch with a slow fetcher
      let resolveFetcher!: (value: unknown) => void;
      const fetcher = (_ctx: FetcherCtx<string>) =>
        new Promise((resolve) => {
          resolveFetcher = resolve;
        });

      const { promise: p2, abort } = cache.prefetch(key, fetcher, { force: true });

      // Abort, then resolve
      abort();
      resolveFetcher({ version: 2 });
      await p2;

      // Original data should remain
      expect(cache.get(key)!.data).toEqual(originalData);
    });
  });

  // T049: force: false with cache hit should NOT call fetcher
  describe("T049: force:false skips fetcher when cache exists", () => {
    it("should not call fetcher when cache already has data and force is false", async () => {
      const key = "/api/cached";
      const initialData = { cached: true };

      // First prefetch to populate cache
      const { promise: p1 } = cache.prefetch(key, () => initialData);
      await p1;
      expect(cache.get(key)!.data).toEqual(initialData);

      // Second prefetch with force:false (default)
      const spyFetcher = vi.fn(() => ({ cached: false }));
      const { promise: p2 } = cache.prefetch(key, spyFetcher);
      await p2;

      expect(spyFetcher).not.toHaveBeenCalled();
      // Original data should be unchanged
      expect(cache.get(key)!.data).toEqual(initialData);
    });

    it("should resolve immediately when cache hit and force is explicitly false", async () => {
      const key = "/api/fast";

      // Populate cache
      const { promise: p1 } = cache.prefetch(key, () => "data");
      await p1;

      // Second call should return a resolved promise
      const spyFetcher = vi.fn(() => "new-data");
      const { promise: p2 } = cache.prefetch(key, spyFetcher, { force: false });
      await p2;

      expect(spyFetcher).not.toHaveBeenCalled();
    });

    it("should call fetcher when cache is empty even with force:false", async () => {
      const key = "/api/empty";
      const spyFetcher = vi.fn(() => "fresh-data");

      const { promise } = cache.prefetch(key, spyFetcher, { force: false });
      await promise;

      expect(spyFetcher).toHaveBeenCalledOnce();
      expect(cache.get(key)!.data).toBe("fresh-data");
    });
  });

  // T050: force: true with existing cache should call fetcher again
  describe("T050: force:true re-fetches even when cache exists", () => {
    it("should call fetcher again when force is true and cache exists", async () => {
      const key = "/api/stale";
      const v1 = { version: 1 };
      const v2 = { version: 2 };

      // Populate cache
      const { promise: p1 } = cache.prefetch(key, () => v1);
      await p1;
      expect(cache.get(key)!.data).toEqual(v1);

      // Force prefetch should call fetcher and update cache
      const spyFetcher = vi.fn(() => v2);
      const { promise: p2 } = cache.prefetch(key, spyFetcher, { force: true });
      await p2;

      expect(spyFetcher).toHaveBeenCalledOnce();
      expect(cache.get(key)!.data).toEqual(v2);
    });

    it("should update timestamp when force re-fetches", async () => {
      const key = "/api/ts";

      const { promise: p1 } = cache.prefetch(key, () => "old");
      await p1;
      const ts1 = cache.get(key)!.timestamp;

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 5));

      const { promise: p2 } = cache.prefetch(key, () => "new", { force: true });
      await p2;
      const ts2 = cache.get(key)!.timestamp;

      expect(ts2).toBeGreaterThanOrEqual(ts1);
      expect(cache.get(key)!.data).toBe("new");
    });
  });

  // GAP-P2: prefetch dedupe with inflight
  describe("prefetch dedupe with inflight", () => {
    it("should not call fetcher when an inflight exists for the same key", async () => {
      const hashedKey = hashKey("/api/shared");
      const observer = {
        id: "ob-1",
        hashedKey,
        lastRawKey: "/api/shared",
        hasData: false,
        onData: () => {},
        onError: () => {},
        onFetchStatusChange: () => {},
      };
      const opts = {
        enabled: true,
        eagerness: "load",
        staleTime: 0,
        cacheTime: 300000,
        revalidateOn: [],
        refreshInterval: 0,
        dedupingInterval: 2000,
        retry: 0,
        retryInterval: 1000,
        timeout: 0,
      } as ResolvedSWROptions;
      store.attachObserver(hashedKey, observer, opts);

      // Start a slow fetch via ensureFetch to create an inflight entry
      let resolveFetcher!: (v: string) => void;
      const slowFetcher = () =>
        new Promise<string>((resolve) => {
          resolveFetcher = resolve;
        });
      store.ensureFetch(hashedKey, "/api/shared", slowFetcher);

      // Now prefetch the same key - should join inflight, NOT call its own fetcher
      const prefetchFetcher = vi.fn(() => "prefetch-data");
      const { promise } = cache.prefetch("/api/shared", prefetchFetcher);

      expect(prefetchFetcher).not.toHaveBeenCalled();

      // Resolve the original fetch
      resolveFetcher("original-data");
      await promise;

      // Data should be from the original fetch
      expect(cache.get("/api/shared")!.data).toBe("original-data");
    });
  });

  // US4: prefetch error handling
  describe("US4: prefetch error handling", () => {
    it("should suppress fetcher error (resolve instead of reject)", async () => {
      const error = new Error("fetch failed");
      const fetcher = (_ctx: FetcherCtx<string>) => Promise.reject(error);

      const { promise } = cache.prefetch("/api/error", fetcher);

      // Errors are suppressed to prevent unhandled rejections
      await expect(promise).resolves.toBeUndefined();
    });

    it("should not store data in cache when fetcher rejects", async () => {
      const fetcher = (_ctx: FetcherCtx<string>) => Promise.reject(new Error("fail"));

      const { promise } = cache.prefetch("/api/no-cache", fetcher);
      await promise; // no need to catch since errors are suppressed

      expect(cache.get("/api/no-cache")).toBeNull();
    });

    it("should ignore error after abort", async () => {
      let rejectFn: (err: Error) => void;
      const fetcher = (_ctx: FetcherCtx<string>) =>
        new Promise<string>((_resolve, reject) => {
          rejectFn = reject;
        });

      const { promise, abort } = cache.prefetch("/api/abort-error", fetcher);

      // Abort before rejection
      abort();
      rejectFn!(new Error("should be ignored"));

      // Promise should resolve without error (abort suppresses rejection)
      await expect(promise).resolves.toBeUndefined();

      // No data should be cached
      expect(cache.get("/api/abort-error")).toBeNull();
    });

    it("should store fetcher and rawKey for later revalidation", async () => {
      const key = "/api/prefetch-revalidate";
      const fetcher = vi.fn((_ctx: FetcherCtx<string>) => "initial");

      const { promise } = cache.prefetch(key, fetcher);
      await promise;

      expect(cache.get(key)!.data).toBe("initial");

      // Now revalidate - should use stored fetcher and rawKey
      fetcher.mockReturnValue("updated");
      const result = store.revalidateByKey(hashKey(key));

      expect(result).toBe(true);

      // Wait for the fetch to complete
      await new Promise((r) => setTimeout(r, 10));

      expect(cache.get(key)!.data).toBe("updated");
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });
});
