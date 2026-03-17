import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { store } from "../../src/cache/store.ts";
import { hashKey } from "../../src/utils/hash.ts";
import { fetchAllPages } from "../../src/hooks/infinite-helpers.ts";
import type { SWRInfiniteKeyLoader, FetcherCtx } from "../../src/types/index.ts";

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
    it("should throw error when a page fetch fails", async () => {
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
    });
  });
});
