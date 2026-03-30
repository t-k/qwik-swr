import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { store } from "../../src/cache/store.ts";
import { hashKey } from "../../src/utils/hash.ts";
import { fetchAllPages, fetchPageWithRetry, calculateRetryDelay, checkIsReachingEnd } from "../../src/hooks/infinite-helpers.ts";
import { applyKeyChangeReset } from "../../src/hooks/infinite-helpers.ts";
import type { SWRInfiniteKeyLoader, FetcherCtx, SWRError, ResolvedQueryConfig, HashedKey } from "../../src/types/index.ts";

describe("swr-infinite integration tests", () => {
  beforeEach(() => {
    store._reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ═══════════════════════════════════════════════════════════════
  // fetchAllPages - multi-page fetch and cache storage
  // ═══════════════════════════════════════════════════════════════

  describe("multi-page fetch and cache storage", () => {
    it("should fetch all pages and store each in cache", async () => {
      const getKey: SWRInfiniteKeyLoader<number[], string> = (pageIndex) => {
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => {
        const page = parseInt(ctx.rawKey.split("=")[1]);
        return [page * 10 + 1, page * 10 + 2];
      };

      const controller = new AbortController();
      const result = await fetchAllPages<number[], string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 3,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
      });

      expect(result.pages).toEqual([
        [1, 2],
        [11, 12],
        [21, 22],
      ]);

      // Verify each page is individually cached
      expect(store.getCache(hashKey("/api/items?page=0"))?.data).toEqual([1, 2]);
      expect(store.getCache(hashKey("/api/items?page=1"))?.data).toEqual([11, 12]);
      expect(store.getCache(hashKey("/api/items?page=2"))?.data).toEqual([21, 22]);
    });

    it("should return stable pageKeys alongside pages", async () => {
      const getKey: SWRInfiniteKeyLoader<string, string> = (pageIndex) => {
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => `data-${ctx.rawKey}`;

      const controller = new AbortController();
      const result = await fetchAllPages<string, string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 2,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
      });

      expect(result.pageKeys).toEqual([
        "/api/items?page=0",
        "/api/items?page=1",
      ]);
    });

    it("should stop fetching when getKey returns null", async () => {
      const fetchCount = { value: 0 };

      const getKey: SWRInfiniteKeyLoader<string[], string> = (pageIndex) => {
        if (pageIndex >= 2) return null;
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => {
        fetchCount.value++;
        return [`item-${ctx.rawKey}`];
      };

      const controller = new AbortController();
      const result = await fetchAllPages<string[], string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 5,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
      });

      expect(result.pages.length).toBe(2);
      expect(result.pageKeys.length).toBe(2);
      expect(result.reachedEnd).toBe(true);
      expect(fetchCount.value).toBe(2);
    });

    it("should detect reachedEnd when next page key is null", async () => {
      const getKey: SWRInfiniteKeyLoader<{ data: number[]; hasNext: boolean }, string> = (
        pageIndex,
        prev,
      ) => {
        if (pageIndex > 0 && prev && !prev.hasNext) return null;
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => {
        const page = parseInt(ctx.rawKey.split("=")[1]);
        return { data: [page], hasNext: page < 1 };
      };

      const controller = new AbortController();
      const result = await fetchAllPages<{ data: number[]; hasNext: boolean }, string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 3,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
      });

      expect(result.pages.length).toBe(2); // page 0 and page 1
      expect(result.reachedEnd).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // setSize - triggering additional fetches
  // ═══════════════════════════════════════════════════════════════

  describe("size change triggering additional fetches", () => {
    it("should fetch additional pages when size increases", async () => {
      const getKey: SWRInfiniteKeyLoader<number[], string> = (pageIndex) => {
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => {
        const page = parseInt(ctx.rawKey.split("=")[1]);
        return [page * 10];
      };

      const controller = new AbortController();

      // Initial fetch: 1 page
      const result1 = await fetchAllPages<number[], string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 1,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
      });

      expect(result1.pages).toEqual([[0]]);

      // Increase to 3 pages - pages 1 and 2 should use fresh cache for page 0
      const result2 = await fetchAllPages<number[], string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 3,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
      });

      expect(result2.pages).toEqual([[0], [10], [20]]);
    });

    it("should use cached data for non-first pages when not revalidateAll", async () => {
      const fetchCount = { value: 0 };

      const getKey: SWRInfiniteKeyLoader<number[], string> = (pageIndex) => {
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => {
        fetchCount.value++;
        const page = parseInt(ctx.rawKey.split("=")[1]);
        return [page * 10];
      };

      const controller = new AbortController();

      // First fetch: 2 pages (2 fetches)
      await fetchAllPages<number[], string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 2,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
      });
      expect(fetchCount.value).toBe(2);

      // Second fetch: 3 pages, page 0 always refetched, page 1 from cache, page 2 new
      fetchCount.value = 0;
      const result = await fetchAllPages<number[], string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 3,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
      });

      // page 0: always fetched (first page)
      // page 1: cached (within staleTime)
      // page 2: new fetch
      expect(fetchCount.value).toBe(2);
      expect(result.pages.length).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // setSize$ size decrease: trim without refetch
  // ═══════════════════════════════════════════════════════════════

  describe("setSize$ size decrease optimization", () => {
    it("should trim data without network request when size decreases", async () => {
      const fetchCount = { value: 0 };

      const getKey: SWRInfiniteKeyLoader<number[], string> = (pageIndex) => {
        if (pageIndex >= 5) return null;
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => {
        fetchCount.value++;
        const page = parseInt(ctx.rawKey.split("=")[1]);
        return [page * 10];
      };

      const controller = new AbortController();

      // Load 3 pages
      const result = await fetchAllPages<number[], string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 3,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
      });

      expect(result.pages).toEqual([[0], [10], [20]]);
      expect(fetchCount.value).toBe(3);

      // Simulate setSize$ decrease: 3 -> 1 (just trim, no fetch)
      const trimmed = result.pages.slice(0, 1);
      const trimmedKeys = result.pageKeys.slice(0, 1);

      expect(trimmed).toEqual([[0]]);
      expect(trimmedKeys).toEqual(["/api/items?page=0"]);

      // isReachingEnd should be rechecked with trimmed data
      const isEnd = checkIsReachingEnd(getKey, trimmed);
      expect(isEnd).toBe(false); // page 1 still exists
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Revalidation
  // ═══════════════════════════════════════════════════════════════

  describe("revalidation of pages", () => {
    it("should refetch all pages when revalidateAll is true", async () => {
      const fetchCount = { value: 0 };

      const getKey: SWRInfiniteKeyLoader<number[], string> = (pageIndex) => {
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => {
        fetchCount.value++;
        const page = parseInt(ctx.rawKey.split("=")[1]);
        return [page * 10 + fetchCount.value];
      };

      const controller = new AbortController();

      // Initial fetch
      await fetchAllPages<number[], string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 3,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
      });
      expect(fetchCount.value).toBe(3);

      // Revalidate all
      fetchCount.value = 0;
      await fetchAllPages<number[], string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 3,
        revalidateAll: true,
        staleTime: 30_000,
        signal: controller.signal,
      });

      // All 3 pages should be refetched
      expect(fetchCount.value).toBe(3);
    });

    it("should use stale cache data when staleTime has not elapsed", async () => {
      const fetchCount = { value: 0 };

      const getKey: SWRInfiniteKeyLoader<string, string> = (pageIndex) => {
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => {
        fetchCount.value++;
        return `page-${ctx.rawKey}-v${fetchCount.value}`;
      };

      const controller = new AbortController();

      // Initial fetch with 2 pages
      await fetchAllPages<string, string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 2,
        revalidateAll: false,
        staleTime: 60_000,
        signal: controller.signal,
      });
      expect(fetchCount.value).toBe(2);

      // Fetch again without revalidateAll - page 1 should be from cache
      fetchCount.value = 0;
      const result = await fetchAllPages<string, string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 2,
        revalidateAll: false,
        staleTime: 60_000,
        signal: controller.signal,
      });

      // Only page 0 refetched (always), page 1 from cache
      expect(fetchCount.value).toBe(1);
      expect(result.pages.length).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Error handling
  // ═══════════════════════════════════════════════════════════════

  describe("error during page fetch", () => {
    it("should throw error when a page fetch fails (no retry)", async () => {
      const getKey: SWRInfiniteKeyLoader<string, string> = (pageIndex) => {
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => {
        if (ctx.rawKey.includes("page=1")) {
          throw new Error("Page 1 failed");
        }
        return `data-${ctx.rawKey}`;
      };

      const controller = new AbortController();

      await expect(
        fetchAllPages<string, string>({
          getKeyFn: getKey,
          fetcherFn: fetcher,
          size: 3,
          revalidateAll: false,
          staleTime: 30_000,
          signal: controller.signal,
        }),
      ).rejects.toThrow("Page 1 failed");
    });

    it("should still have page 0 cached even if page 1 fails", async () => {
      const getKey: SWRInfiniteKeyLoader<string, string> = (pageIndex) => {
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => {
        if (ctx.rawKey.includes("page=1")) {
          throw new Error("Page 1 failed");
        }
        return `data-${ctx.rawKey}`;
      };

      const controller = new AbortController();

      try {
        await fetchAllPages<string, string>({
          getKeyFn: getKey,
          fetcherFn: fetcher,
          size: 3,
          revalidateAll: false,
          staleTime: 30_000,
          signal: controller.signal,
        });
      } catch {
        // expected
      }

      // Page 0 was cached before the error
      expect(store.getCache(hashKey("/api/items?page=0"))?.data).toBe(
        "data-/api/items?page=0",
      );
      // Page 1 was not cached (failed)
      expect(store.getCache(hashKey("/api/items?page=1"))).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Abort handling
  // ═══════════════════════════════════════════════════════════════

  describe("abort signal handling", () => {
    it("should throw AbortError when signal is aborted before fetch starts", async () => {
      const getKey: SWRInfiniteKeyLoader<string, string> = (pageIndex) => {
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => {
        return `data-${ctx.rawKey}`;
      };

      const controller = new AbortController();
      controller.abort(); // abort immediately

      await expect(
        fetchAllPages<string, string>({
          getKeyFn: getKey,
          fetcherFn: fetcher,
          size: 3,
          revalidateAll: false,
          staleTime: 30_000,
          signal: controller.signal,
        }),
      ).rejects.toThrow("Aborted");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Optimistic data updates via cache
  // ═══════════════════════════════════════════════════════════════

  describe("optimistic data updates", () => {
    it("should support updating individual page caches for optimistic mutation", () => {
      // Simulate pages already in cache
      const page0Key = "/api/items?page=0";
      const page1Key = "/api/items?page=1";
      const hashed0 = hashKey(page0Key);
      const hashed1 = hashKey(page1Key);

      store.setCache(hashed0, { data: [{ id: 1 }], timestamp: Date.now() });
      store.setCache(hashed1, { data: [{ id: 2 }], timestamp: Date.now() });

      // Optimistic update: add item to page 0
      const currentPage0 = store.getCache<{ id: number }[]>(hashed0)?.data ?? [];
      const optimisticPage0 = [...currentPage0, { id: 999 }];
      store.setCache(hashed0, { data: optimisticPage0, timestamp: Date.now() });

      expect(store.getCache(hashed0)?.data).toEqual([{ id: 1 }, { id: 999 }]);
      expect(store.getCache(hashed1)?.data).toEqual([{ id: 2 }]);
    });

    it("should support rollback of optimistic page update", () => {
      const hashed = hashKey("/api/items?page=0");
      const original = [{ id: 1 }];

      store.setCache(hashed, { data: original, timestamp: Date.now() });
      const snapshot = store.getCache(hashed)!;

      // Optimistic update
      store.setCache(hashed, { data: [{ id: 1 }, { id: 999 }], timestamp: Date.now() });

      // Rollback
      store.setCache(hashed, snapshot);

      expect(store.getCache(hashed)?.data).toEqual(original);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // mutate$ with function updater
  // ═══════════════════════════════════════════════════════════════

  describe("mutate$ with function updater", () => {
    it("should update page data via function and sync to cache", async () => {
      const getKey: SWRInfiniteKeyLoader<number[], string> = (pageIndex) => {
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => {
        const page = parseInt(ctx.rawKey.split("=")[1]);
        return [page * 10 + 1, page * 10 + 2];
      };

      const controller = new AbortController();

      // Initial fetch
      await fetchAllPages<number[], string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 2,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
      });

      // Simulate mutate$ function updater: append item to first page
      const hashed0 = hashKey("/api/items?page=0");
      const current = store.getCache<number[]>(hashed0)?.data ?? [];
      const updated = [...current, 999];
      store.setCache(hashed0, { data: updated, timestamp: Date.now() });

      expect(store.getCache(hashed0)?.data).toEqual([1, 2, 999]);
      // Page 1 unchanged
      expect(store.getCache(hashKey("/api/items?page=1"))?.data).toEqual([11, 12]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Stable page keys for mutate$ (cursor corruption prevention)
  // ═══════════════════════════════════════════════════════════════

  describe("stable page keys (cursor corruption prevention)", () => {
    it("should return pageKeys from fetchAllPages for use in mutate$", async () => {
      type Page = { items: string[]; nextCursor: string | null };

      const getKey: SWRInfiniteKeyLoader<Page, string> = (pageIndex, prev) => {
        if (pageIndex === 0) return "/api/items";
        if (!prev?.nextCursor) return null;
        return `/api/items?cursor=${prev.nextCursor}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>): Promise<Page> => {
        if (ctx.rawKey === "/api/items") {
          return { items: ["a", "b"], nextCursor: "cursor-1" };
        }
        return { items: ["c", "d"], nextCursor: null };
      };

      const controller = new AbortController();
      const result = await fetchAllPages<Page, string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 2,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
      });

      // pageKeys should reflect the keys used at fetch time
      expect(result.pageKeys).toEqual(["/api/items", "/api/items?cursor=cursor-1"]);

      // mutate$ should use these stable keys (not re-derived from mutated data)
      // Simulate: optimistic update changes page 0's nextCursor
      const stableHashes = result.pageKeys.map(hashKey);
      const mutatedPage0: Page = { items: ["a", "b", "NEW"], nextCursor: "cursor-CHANGED" };

      // Write using stable keys: page 1 stays under its original key
      store.setCache(stableHashes[0], { data: mutatedPage0, timestamp: Date.now() });

      // Page 1 data is still under the ORIGINAL key, not cursor-CHANGED
      expect(store.getCache(hashKey("/api/items?cursor=cursor-1"))?.data).toEqual(
        { items: ["c", "d"], nextCursor: null },
      );

      // No data under the wrong key
      expect(store.getCache(hashKey("/api/items?cursor=cursor-CHANGED"))).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // fetchAllPages with stale cache (staleTime expired)
  // ═══════════════════════════════════════════════════════════════

  describe("stale cache refetch", () => {
    it("should refetch non-first pages when their cache has expired staleTime", async () => {
      const fetchCount = { value: 0 };

      const getKey: SWRInfiniteKeyLoader<string, string> = (pageIndex) => {
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => {
        fetchCount.value++;
        return `data-v${fetchCount.value}-${ctx.rawKey}`;
      };

      const controller = new AbortController();

      // Initial fetch with staleTime=100ms
      await fetchAllPages<string, string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 2,
        revalidateAll: false,
        staleTime: 100,
        signal: controller.signal,
      });
      expect(fetchCount.value).toBe(2);

      // Advance time past staleTime
      vi.advanceTimersByTime(200);

      // Fetch again - both pages should be refetched (page 0 always, page 1 because stale)
      fetchCount.value = 0;
      await fetchAllPages<string, string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 2,
        revalidateAll: false,
        staleTime: 100,
        signal: controller.signal,
      });

      expect(fetchCount.value).toBe(2); // both refetched
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Per-page retry with exponential backoff
  // ═══════════════════════════════════════════════════════════════

  describe("per-page retry", () => {
    it("should retry a failed page fetch with exponential backoff", async () => {
      vi.useRealTimers(); // real timers for async retry tests

      let attempts = 0;
      const fetcher = async (_ctx: FetcherCtx<string>): Promise<string> => {
        attempts++;
        if (attempts <= 2) throw new Error(`Attempt ${attempts} failed`);
        return "success";
      };

      const controller = new AbortController();
      const result = await fetchPageWithRetry<string, string>(
        fetcher,
        "/api/items",
        hashKey("/api/items"),
        controller.signal,
        { retry: 3, retryInterval: 1, timeout: 0 }, // 1ms delays for speed
      );

      expect(result).toBe("success");
      expect(attempts).toBe(3);
    });

    it("should throw after all retries exhausted", async () => {
      vi.useRealTimers();

      let attempts = 0;
      const fetcher = async (_ctx: FetcherCtx<string>): Promise<string> => {
        attempts++;
        throw new Error("Always fails");
      };

      const controller = new AbortController();

      await expect(
        fetchPageWithRetry<string, string>(
          fetcher,
          "/api/items",
          hashKey("/api/items"),
          controller.signal,
          { retry: 2, retryInterval: 1, timeout: 0 },
        ),
      ).rejects.toThrow("Always fails");

      expect(attempts).toBe(3); // 1 initial + 2 retries
    });

    it("should not retry when retry is 0", async () => {
      vi.useRealTimers();

      let attempts = 0;
      const fetcher = async (_ctx: FetcherCtx<string>): Promise<string> => {
        attempts++;
        throw new Error("Fail");
      };

      const controller = new AbortController();

      await expect(
        fetchPageWithRetry<string, string>(
          fetcher,
          "/api/items",
          hashKey("/api/items"),
          controller.signal,
          { retry: 0, retryInterval: 1, timeout: 0 },
        ),
      ).rejects.toThrow("Fail");

      expect(attempts).toBe(1);
    });

    it("should abort retry when parent signal is aborted", async () => {
      vi.useRealTimers();

      let attempts = 0;
      const fetcher = async (_ctx: FetcherCtx<string>): Promise<string> => {
        attempts++;
        throw new Error("Fail");
      };

      const controller = new AbortController();

      const promise = fetchPageWithRetry<string, string>(
        fetcher,
        "/api/items",
        hashKey("/api/items"),
        controller.signal,
        { retry: 3, retryInterval: 100, timeout: 0 },
      );

      // Give first attempt time to fail, then abort during delay
      await new Promise(r => setTimeout(r, 10));
      controller.abort();

      await expect(promise).rejects.toThrow("Aborted");
      expect(attempts).toBe(1);
    });

    it("should work with fetchAllPages when retryConfig is provided", async () => {
      vi.useRealTimers();

      let page1Attempts = 0;

      const getKey: SWRInfiniteKeyLoader<string, string> = (pageIndex) => {
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>): Promise<string> => {
        if (ctx.rawKey.includes("page=1")) {
          page1Attempts++;
          if (page1Attempts <= 1) throw new Error("Page 1 transient failure");
        }
        return `data-${ctx.rawKey}`;
      };

      const controller = new AbortController();

      const result = await fetchAllPages<string, string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 2,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
        retryConfig: { retry: 2, retryInterval: 1, timeout: 0 },
      });

      expect(result.pages.length).toBe(2);
      expect(page1Attempts).toBe(2); // 1 fail + 1 success
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // calculateRetryDelay
  // ═══════════════════════════════════════════════════════════════

  describe("calculateRetryDelay", () => {
    it("should calculate exponential backoff", () => {
      const err = { type: "unknown", message: "err", retryCount: 0, timestamp: 0 } as SWRError;
      expect(calculateRetryDelay(0, err, 1000)).toBe(1000);  // 1000 * 2^0
      expect(calculateRetryDelay(1, err, 1000)).toBe(2000);  // 1000 * 2^1
      expect(calculateRetryDelay(2, err, 1000)).toBe(4000);  // 1000 * 2^2
    });

    it("should support custom delay function", () => {
      const err = { type: "unknown", message: "err", retryCount: 0, timestamp: 0 } as SWRError;
      const customDelay = (count: number) => count * 500;
      expect(calculateRetryDelay(0, err, customDelay)).toBe(0);
      expect(calculateRetryDelay(1, err, customDelay)).toBe(500);
      expect(calculateRetryDelay(2, err, customDelay)).toBe(1000);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // cacheTime / queryConfigMap registration
  // ═══════════════════════════════════════════════════════════════

  describe("cacheTime / queryConfigMap registration", () => {
    it("should register queryConfig for each page key when resolvedConfig is provided", async () => {
      const getKey: SWRInfiniteKeyLoader<string, string> = (pageIndex) => {
        return `/api/items?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => `data-${ctx.rawKey}`;

      const controller = new AbortController();

      const mockConfig = {
        enabled: true,
        eagerness: "visible" as const,
        staleTime: 30_000,
        cacheTime: 120_000, // custom cacheTime
        dedupingInterval: 5_000,
        revalidateOn: [] as ("focus" | "reconnect" | "interval")[],
        refreshInterval: 0,
        retry: 3,
        retryInterval: 1000,
        timeout: 30_000,
        keepPreviousData: false,
      } satisfies ResolvedQueryConfig;

      await fetchAllPages<string, string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 2,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
        resolvedConfig: mockConfig,
      });

      // GC should use our custom cacheTime (120s), not the default (300s)
      expect(store.getCacheTime(hashKey("/api/items?page=0"))).toBe(120_000);
      expect(store.getCacheTime(hashKey("/api/items?page=1"))).toBe(120_000);
    });

    it("should fall back to default cacheTime when resolvedConfig is not provided", async () => {
      const getKey: SWRInfiniteKeyLoader<string, string> = (pageIndex) => {
        return `/api/no-config?page=${pageIndex}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>) => `data-${ctx.rawKey}`;
      const controller = new AbortController();

      await fetchAllPages<string, string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 1,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
        // no resolvedConfig
      });

      // Should fall back to default 300_000
      expect(store.getCacheTime(hashKey("/api/no-config?page=0"))).toBe(300_000);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Cursor-based pagination pattern
  // ═══════════════════════════════════════════════════════════════

  describe("cursor-based pagination", () => {
    it("should support cursor-based pagination where each key depends on previous data", async () => {
      type Page = { items: string[]; nextCursor: string | null };

      const getKey: SWRInfiniteKeyLoader<Page, string> = (pageIndex, prev) => {
        if (pageIndex === 0) return "/api/items";
        if (!prev?.nextCursor) return null;
        return `/api/items?cursor=${prev.nextCursor}`;
      };

      const fetcher = async (ctx: FetcherCtx<string>): Promise<Page> => {
        if (ctx.rawKey === "/api/items") {
          return { items: ["a", "b"], nextCursor: "cursor-1" };
        }
        if (ctx.rawKey === "/api/items?cursor=cursor-1") {
          return { items: ["c", "d"], nextCursor: "cursor-2" };
        }
        return { items: ["e"], nextCursor: null };
      };

      const controller = new AbortController();
      const result = await fetchAllPages<Page, string>({
        getKeyFn: getKey,
        fetcherFn: fetcher,
        size: 3,
        revalidateAll: false,
        staleTime: 30_000,
        signal: controller.signal,
      });

      expect(result.pages.length).toBe(3);
      expect(result.pages[0].items).toEqual(["a", "b"]);
      expect(result.pages[1].items).toEqual(["c", "d"]);
      expect(result.pages[2].items).toEqual(["e"]);
      expect(result.reachedEnd).toBe(true); // nextCursor is null for page 2

      // Verify stable keys for cursor-based pagination
      expect(result.pageKeys).toEqual([
        "/api/items",
        "/api/items?cursor=cursor-1",
        "/api/items?cursor=cursor-2",
      ]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // keepPreviousData - state reset on key change
  // ═══════════════════════════════════════════════════════════════

  describe("keepPreviousData", () => {
    it("should preserve state.data when keepPreviousData is true and key changes", () => {
      const state = {
        data: [["page0-A"], ["page1-A"]] as string[][] | undefined,
        error: undefined as SWRError | undefined,
        isReachingEnd: false,
      };
      const _internal = {
        prevFirstKeyHash: hashKey("/api/a") as HashedKey | null,
      };

      applyKeyChangeReset(state, _internal, hashKey("/api/b"), true);

      expect(state.data).toEqual([["page0-A"], ["page1-A"]]);
      expect(_internal.prevFirstKeyHash).toBe(hashKey("/api/b"));
    });

    it("should clear stale error on key change even with keepPreviousData true", () => {
      const staleError: SWRError = {
        type: "fetch",
        message: "previous key failed",
        status: 500,
        retryCount: 0,
        timestamp: Date.now(),
      };
      const state = {
        data: [["page0-A"]] as string[][] | undefined,
        error: staleError as SWRError | undefined,
        isReachingEnd: false,
      };
      const _internal = {
        prevFirstKeyHash: hashKey("/api/a") as HashedKey | null,
      };

      applyKeyChangeReset(state, _internal, hashKey("/api/b"), true);

      // Data preserved, but stale error cleared
      expect(state.data).toEqual([["page0-A"]]);
      expect(state.error).toBeUndefined();
    });

    it("should clear state.data when keepPreviousData is false and key changes", () => {
      const state = {
        data: [["page0-A"], ["page1-A"]] as string[][] | undefined,
        error: undefined as SWRError | undefined,
        isReachingEnd: false,
      };
      const _internal = {
        prevFirstKeyHash: hashKey("/api/a") as HashedKey | null,
      };

      applyKeyChangeReset(state, _internal, hashKey("/api/b"), false);

      expect(state.data).toBeUndefined();
      expect(state.error).toBeUndefined();
      expect(state.isReachingEnd).toBe(false);
      expect(_internal.prevFirstKeyHash).toBe(hashKey("/api/b"));
    });

    it("should clear state.data on disabled transition even with keepPreviousData true", () => {
      const state = {
        data: [["page0-A"]] as string[][] | undefined,
        error: undefined as SWRError | undefined,
        isReachingEnd: false,
      };
      const _internal = {
        prevFirstKeyHash: hashKey("/api/a") as HashedKey | null,
      };

      applyKeyChangeReset(state, _internal, null, true);

      expect(state.data).toBeUndefined();
      expect(state.error).toBeUndefined();
      expect(state.isReachingEnd).toBe(false);
      expect(_internal.prevFirstKeyHash).toBeNull();
    });

    it("should not reset state when key has not changed", () => {
      const state = {
        data: [["page0-A"], ["page1-A"]] as string[][] | undefined,
        error: undefined as SWRError | undefined,
        isReachingEnd: false,
      };
      const keyHash = hashKey("/api/a");
      const _internal = {
        prevFirstKeyHash: keyHash as HashedKey | null,
      };

      applyKeyChangeReset(state, _internal, keyHash, false);

      expect(state.data).toEqual([["page0-A"], ["page1-A"]]);
      expect(_internal.prevFirstKeyHash).toBe(keyHash);
    });

    it("should only record key on first invocation without resetting state", () => {
      const state = {
        data: [["page0-A"]] as string[][],
        error: undefined as SWRError | undefined,
        isReachingEnd: false,
      };
      const _internal = {
        prevFirstKeyHash: null as HashedKey | null,
      };
      const keyHash = hashKey("/api/a");

      // First invocation: prevFirstKeyHash is null
      applyKeyChangeReset(state, _internal, keyHash, false);

      // Should record key without resetting state
      expect(state.data).toEqual([["page0-A"]]);
      expect(_internal.prevFirstKeyHash).toBe(keyHash);
    });
  });
});
