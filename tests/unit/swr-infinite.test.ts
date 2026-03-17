import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { store } from "../../src/cache/store.ts";
import { hashKey } from "../../src/utils/hash.ts";
import {
  resolvePageKeys,
  checkIsReachingEnd,
} from "../../src/hooks/infinite-helpers.ts";
import type { SWRInfiniteKeyLoader } from "../../src/types/index.ts";

describe("useSWRInfinite unit tests", () => {
  beforeEach(() => {
    store._reset();
  });

  // ═══════════════════════════════════════════════════════════════
  // resolvePageKeys
  // ═══════════════════════════════════════════════════════════════

  describe("resolvePageKeys", () => {
    it("should resolve keys for all pages sequentially", () => {
      const getKey: SWRInfiniteKeyLoader<string[], string> = (pageIndex, _prev) => {
        return `/api/items?page=${pageIndex}`;
      };

      const keys = resolvePageKeys(getKey, [], 3);
      expect(keys).toEqual([
        "/api/items?page=0",
        "/api/items?page=1",
        "/api/items?page=2",
      ]);
    });

    it("should pass previousPageData to getKey", () => {
      const getKey: SWRInfiniteKeyLoader<{ next: string | null }, string> = (pageIndex, prev) => {
        if (pageIndex === 0) return "/api/items";
        if (prev?.next === null) return null;
        return prev!.next!;
      };

      const pageData = [
        { next: "/api/items?cursor=abc" },
        { next: "/api/items?cursor=def" },
        { next: null },
      ];

      const keys = resolvePageKeys(getKey, pageData, 4);
      expect(keys).toEqual([
        "/api/items",
        "/api/items?cursor=abc",
        "/api/items?cursor=def",
        null, // stopped because next is null
      ]);
    });

    it("should stop early when getKey returns null", () => {
      const getKey: SWRInfiniteKeyLoader<string[], string> = (pageIndex, _prev) => {
        if (pageIndex >= 2) return null;
        return `/api/items?page=${pageIndex}`;
      };

      const keys = resolvePageKeys(getKey, [], 5);
      // Should only have 3 entries (page 0, page 1, null for page 2)
      expect(keys).toEqual([
        "/api/items?page=0",
        "/api/items?page=1",
        null,
      ]);
    });

    it("should return empty array for size 0", () => {
      const getKey: SWRInfiniteKeyLoader<string[], string> = () => "/api/items";
      const keys = resolvePageKeys(getKey, [], 0);
      expect(keys).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // checkIsReachingEnd
  // ═══════════════════════════════════════════════════════════════

  describe("checkIsReachingEnd", () => {
    it("should return true when getKey returns null for the next page", () => {
      const getKey: SWRInfiniteKeyLoader<number[], string> = (pageIndex, _prev) => {
        if (pageIndex >= 3) return null;
        return `/api/items?page=${pageIndex}`;
      };

      const pages = [[1, 2], [3, 4], [5, 6]];
      expect(checkIsReachingEnd(getKey, pages)).toBe(true);
    });

    it("should return false when getKey returns a valid key for the next page", () => {
      const getKey: SWRInfiniteKeyLoader<number[], string> = (pageIndex, _prev) => {
        return `/api/items?page=${pageIndex}`;
      };

      const pages = [[1, 2], [3, 4]];
      expect(checkIsReachingEnd(getKey, pages)).toBe(false);
    });

    it("should return true for empty pages when getKey(0, null) returns null", () => {
      const getKey: SWRInfiniteKeyLoader<number[], string> = () => null;
      expect(checkIsReachingEnd(getKey, [])).toBe(true);
    });

    it("should pass the last page data to getKey", () => {
      const getKey: SWRInfiniteKeyLoader<{ items: number[]; hasMore: boolean }, string> = (
        pageIndex,
        prev,
      ) => {
        if (pageIndex > 0 && prev && !prev.hasMore) return null;
        return `/api/items?page=${pageIndex}`;
      };

      const pagesWithMore = [
        { items: [1], hasMore: true },
        { items: [2], hasMore: true },
      ];
      expect(checkIsReachingEnd(getKey, pagesWithMore)).toBe(false);

      const pagesAtEnd = [
        { items: [1], hasMore: true },
        { items: [2], hasMore: false },
      ];
      expect(checkIsReachingEnd(getKey, pagesAtEnd)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Page cache interactions
  // ═══════════════════════════════════════════════════════════════

  describe("page cache interactions", () => {
    it("should cache each page individually by its key", () => {
      const page0Data = [{ id: 1 }, { id: 2 }];
      const page1Data = [{ id: 3 }, { id: 4 }];

      const hashed0 = hashKey("/api/items?page=0");
      const hashed1 = hashKey("/api/items?page=1");

      store.setCache(hashed0, { data: page0Data, timestamp: Date.now() });
      store.setCache(hashed1, { data: page1Data, timestamp: Date.now() });

      expect(store.getCache(hashed0)?.data).toEqual(page0Data);
      expect(store.getCache(hashed1)?.data).toEqual(page1Data);
    });

    it("should allow updating a single page cache without affecting others", () => {
      const hashed0 = hashKey("/api/items?page=0");
      const hashed1 = hashKey("/api/items?page=1");

      store.setCache(hashed0, { data: ["a"], timestamp: Date.now() });
      store.setCache(hashed1, { data: ["b"], timestamp: Date.now() });

      // Update only page 0
      store.setCache(hashed0, { data: ["a-updated"], timestamp: Date.now() });

      expect(store.getCache(hashed0)?.data).toEqual(["a-updated"]);
      expect(store.getCache(hashed1)?.data).toEqual(["b"]);
    });

    it("should allow deleting a single page from cache", () => {
      const hashed0 = hashKey("/api/items?page=0");
      const hashed1 = hashKey("/api/items?page=1");

      store.setCache(hashed0, { data: "page0", timestamp: Date.now() });
      store.setCache(hashed1, { data: "page1", timestamp: Date.now() });

      store.deleteCache(hashed0);

      expect(store.getCache(hashed0)).toBeNull();
      expect(store.getCache(hashed1)?.data).toBe("page1");
    });
  });
});
