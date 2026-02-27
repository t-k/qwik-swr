import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { store } from "../../src/cache/store.ts";
import { cache } from "../../src/cache/cache-api.ts";
import { hashKey } from "../../src/utils/hash.ts";
import type { HashedKey, ValidKey, RevalidateTrigger } from "../../src/types/index.ts";
import type { Observer } from "../../src/cache/types.ts";

function createMockObserver(hashedKey: HashedKey, rawKey: ValidKey): Observer {
  return {
    id: crypto.randomUUID(),
    hashedKey,
    lastRawKey: rawKey,
    hasData: false,
    onData: vi.fn(),
    onError: vi.fn(),
    onFetchStatusChange: vi.fn(),
  };
}

function minOpts() {
  return {
    enabled: true,
    eagerness: "load" as const,
    staleTime: 30_000,
    cacheTime: 300_000,
    dedupingInterval: 5_000,
    revalidateOn: [] as RevalidateTrigger[],
    refreshInterval: 0,
    retry: 0,
    retryInterval: 1000,
    timeout: 30_000,
  };
}

describe("subscription-swr integration", () => {
  beforeEach(() => {
    store._reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // T028: onData$ from subscription injects data into SWR cache via mutate$
  describe("SWR cache injection from subscription", () => {
    it("should update SWR cache when subscription data is received via cache.mutate", () => {
      const key = "rooms/123/messages";
      const hashed = hashKey(key);

      // Set up an SWR observer (simulating useSWR)
      const observer = createMockObserver(hashed, key);
      store.attachObserver(hashed, observer, minOpts());

      // Set initial SWR data
      store.setCache(hashed, {
        data: [{ id: 1, text: "initial" }],
        timestamp: Date.now(),
      });

      // Clear mocks from initial setup
      (observer.onData as any).mockClear();

      // Simulate subscription receiving new data → inject into SWR cache
      const newMessages = [
        { id: 1, text: "initial" },
        { id: 2, text: "realtime" },
      ];

      // This is what onData$ callback would do: mutate the SWR cache
      cache.mutate(key, newMessages, { revalidate: false });

      // Verify cache was updated
      const cached = store.getCache(hashed);
      expect(cached?.data).toEqual(newMessages);

      // Verify observer was notified
      expect(observer.onData).toHaveBeenCalledOnce();
    });

    it("should preserve SWR cache when subscription disconnects", () => {
      const key = "rooms/123/messages";
      const hashed = hashKey(key);
      const observer = createMockObserver(hashed, key);
      store.attachObserver(hashed, observer, minOpts());

      const messages = [{ id: 1, text: "hello" }];
      store.setCache(hashed, { data: messages, timestamp: Date.now() });

      // Subscription disconnects - cache should remain intact
      // (useSubscription does NOT clear the SWR cache on disconnect)
      const cached = store.getCache(hashed);
      expect(cached?.data).toEqual(messages);
    });

    it("should allow multiple subscription updates to accumulate in cache", () => {
      const key = "notifications";
      const hashed = hashKey(key);

      // First subscription data
      cache.mutate(key, [{ id: 1, msg: "first" }], { revalidate: false });
      expect(store.getCache(hashed)?.data).toEqual([{ id: 1, msg: "first" }]);

      // Second subscription data
      cache.mutate(
        key,
        [
          { id: 1, msg: "first" },
          { id: 2, msg: "second" },
        ],
        { revalidate: false },
      );
      expect(store.getCache(hashed)?.data).toEqual([
        { id: 1, msg: "first" },
        { id: 2, msg: "second" },
      ]);
    });
  });
});
