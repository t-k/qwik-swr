import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { store } from "../../src/cache/store.ts";
import type { HashedKey, ResolvedSWROptions } from "../../src/types/index.ts";
import {
  makeObserver,
  makeOptions as makeOptionsBase,
  makeFetcher,
  resetObserverIdCounter,
} from "../../tests/helpers/index.ts";

// Override defaults for dedupe tests: staleTime=0, retry=0, revalidateOn=[]
function makeOptions(overrides: Partial<ResolvedSWROptions> = {}): ResolvedSWROptions {
  return makeOptionsBase({ staleTime: 0, retry: 0, revalidateOn: [], ...overrides });
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("T023: Dedupe behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store._reset();
    resetObserverIdCounter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Stage 1: In-flight dedupe ───

  describe("Stage 1: in-flight dedupe", () => {
    it("2 observers with same key trigger only 1 fetch call and both receive same data", async () => {
      const key = "s:/api/users" as HashedKey;
      const opts = makeOptions();
      const fetcher = makeFetcher({ users: ["alice", "bob"] });

      const obA = makeObserver(key);
      const obB = makeObserver(key);

      store.attachObserver(key, obA, opts);
      store.attachObserver(key, obB, opts);

      // Both observers call ensureFetch -- second should join the first
      store.ensureFetch(key, "/api/users", fetcher);
      store.ensureFetch(key, "/api/users", fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);

      // Both observers should receive fetching status
      expect(obA.onFetchStatusChange).toHaveBeenCalledWith("fetching");
      expect(obB.onFetchStatusChange).toHaveBeenCalledWith("fetching");

      // Advance timer to resolve the fetch
      await vi.advanceTimersByTimeAsync(50);

      // Both observers receive the same data
      expect(obA.onData).toHaveBeenCalledWith(
        expect.objectContaining({ data: { users: ["alice", "bob"] } }),
      );
      expect(obB.onData).toHaveBeenCalledWith(
        expect.objectContaining({ data: { users: ["alice", "bob"] } }),
      );
    });

    it("second ensureFetch during in-flight updates observerCount without new fetch", async () => {
      const key = "s:/api/posts" as HashedKey;
      const opts = makeOptions();
      const fetcher = makeFetcher("posts-data", 100);

      const obA = makeObserver(key);
      store.attachObserver(key, obA, opts);
      store.ensureFetch(key, "/api/posts", fetcher);

      // Attach a second observer while fetch is in-flight
      const obB = makeObserver(key);
      store.attachObserver(key, obB, opts);
      store.ensureFetch(key, "/api/posts", fetcher);

      // Still only 1 fetch call
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Both should be notified of fetching status
      expect(obB.onFetchStatusChange).toHaveBeenCalledWith("fetching");

      await vi.advanceTimersByTimeAsync(100);

      // Both receive data
      expect(obA.onData).toHaveBeenCalled();
      expect(obB.onData).toHaveBeenCalled();
    });
  });

  // ─── Stage 2: Cooldown suppression ───

  describe("Stage 2: cooldown suppression", () => {
    it("after fetch completes, new observer with hasData=true gets cooldown suppression", async () => {
      const key = "s:/api/items" as HashedKey;
      const opts = makeOptions({ dedupingInterval: 5_000 });
      const fetcher = makeFetcher("items-data", 50);

      // First observer fetches data
      const obA = makeObserver(key);
      store.attachObserver(key, obA, opts);
      store.ensureFetch(key, "/api/items", fetcher);

      // Complete the fetch
      await vi.advanceTimersByTimeAsync(50);
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Now within dedupingInterval (5000ms), attach a new observer that already has data
      // After fetch completion, obA.hasData should be true (set by notifyObservers)
      // Attach a new observer -- since cache exists, attachObserver sets hasData=true
      const obB = makeObserver(key, { hasData: false });
      store.attachObserver(key, obB, opts);

      // obB should have received cached data via attachObserver
      expect(obB.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "items-data" }));

      // Now ensureFetch -- cooldown is active + data exists -> suppressed
      store.ensureFetch(key, "/api/items", fetcher);

      // No new fetch should have been triggered
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("cooldown expires after dedupingInterval, allowing new fetch", async () => {
      const key = "s:/api/expire" as HashedKey;
      const opts = makeOptions({ dedupingInterval: 2_000 });
      const fetcher = makeFetcher("data-v1", 50);

      const ob = makeObserver(key);
      store.attachObserver(key, ob, opts);
      store.ensureFetch(key, "/api/expire", fetcher);

      // Complete fetch
      await vi.advanceTimersByTimeAsync(50);
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Advance past dedupingInterval
      await vi.advanceTimersByTimeAsync(2_000);

      // Now ensureFetch should trigger a new fetch (staleTime=0 means data is stale)
      store.ensureFetch(key, "/api/expire", fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Cooldown bypass for volatile mode ───

  describe("Cooldown bypass: volatile mode (hasData=false)", () => {
    it("observer without data bypasses cooldown and triggers new fetch", async () => {
      const key = "s:/api/volatile" as HashedKey;
      // volatile: cacheTime=0, so data is NOT stored in cacheMap
      const opts = makeOptions({
        cacheTime: 0,
        dedupingInterval: 5_000,
      });
      const fetcher = makeFetcher("volatile-data", 50);

      // First observer fetches and receives data
      const obA = makeObserver(key);
      store.attachObserver(key, obA, opts);
      store.ensureFetch(key, "/api/volatile", fetcher);

      // Complete the fetch
      await vi.advanceTimersByTimeAsync(50);
      expect(fetcher).toHaveBeenCalledTimes(1);

      // obA received data via notifyObservers, so obA.hasData = true
      // But cacheMap has NO entry (cacheTime=0)

      // Detach obA so no observer has data anymore
      store.detachObserver(key, obA);

      // Attach a fresh observer that has no data
      const obB = makeObserver(key, { hasData: false });
      store.attachObserver(key, obB, opts);

      // obB.hasData should remain false since cacheMap is empty (volatile)
      // attachObserver only calls onData if cacheMap has an entry

      // ensureFetch: cooldown is active, but canCooldownSuppress = false
      // (no cache + no observer has data) -> cooldown bypass -> new fetch
      store.ensureFetch(key, "/api/volatile", fetcher);

      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("observer with data during cooldown still gets suppressed even in volatile config", async () => {
      const key = "s:/api/volatile2" as HashedKey;
      const opts = makeOptions({
        cacheTime: 0,
        dedupingInterval: 5_000,
      });
      const fetcher = makeFetcher("volatile-data", 50);

      const obA = makeObserver(key);
      store.attachObserver(key, obA, opts);
      store.ensureFetch(key, "/api/volatile", fetcher);

      // Complete the fetch -- obA.hasData becomes true via notifyObservers
      await vi.advanceTimersByTimeAsync(50);
      expect(fetcher).toHaveBeenCalledTimes(1);

      // obA still attached and has data. cooldown active.
      // Even though cacheTime=0, obA.hasData is true -> canCooldownSuppress = true
      store.ensureFetch(key, "/api/volatile", fetcher);

      // Suppressed: no new fetch
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Multiple keys: independent fetching ───

  describe("Multiple keys fetch independently", () => {
    it("different keys should trigger separate fetches", async () => {
      const keyA = "s:/api/users" as HashedKey;
      const keyB = "s:/api/posts" as HashedKey;
      const opts = makeOptions();

      const fetcherA = makeFetcher("users-data", 50);
      const fetcherB = makeFetcher("posts-data", 80);

      const obA = makeObserver(keyA);
      const obB = makeObserver(keyB);

      store.attachObserver(keyA, obA, opts);
      store.attachObserver(keyB, obB, opts);

      store.ensureFetch(keyA, "/api/users", fetcherA);
      store.ensureFetch(keyB, "/api/posts", fetcherB);

      // Each fetcher called exactly once
      expect(fetcherA).toHaveBeenCalledTimes(1);
      expect(fetcherB).toHaveBeenCalledTimes(1);

      // Advance to resolve fetcherA (50ms)
      await vi.advanceTimersByTimeAsync(50);

      // obA receives data, obB does not yet
      expect(obA.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "users-data" }));
      expect(obB.onData).not.toHaveBeenCalled();

      // Advance to resolve fetcherB (30ms more to reach 80ms)
      await vi.advanceTimersByTimeAsync(30);

      expect(obB.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "posts-data" }));
    });

    it("cooldown on key A does not affect key B", async () => {
      const keyA = "s:/api/alpha" as HashedKey;
      const keyB = "s:/api/beta" as HashedKey;
      const opts = makeOptions({ dedupingInterval: 5_000 });

      const fetcherA = makeFetcher("alpha", 50);
      const fetcherB = makeFetcher("beta", 50);

      const obA = makeObserver(keyA);
      const obB = makeObserver(keyB);

      store.attachObserver(keyA, obA, opts);
      store.attachObserver(keyB, obB, opts);

      // Fetch key A
      store.ensureFetch(keyA, "/api/alpha", fetcherA);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetcherA).toHaveBeenCalledTimes(1);

      // Key A is now in cooldown. Key B should still be fetchable.
      store.ensureFetch(keyB, "/api/beta", fetcherB);
      expect(fetcherB).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Observer count tracking ───

  describe("Observer count tracking", () => {
    it("observerCount reflects actual observer count during in-flight", async () => {
      const key = "s:/api/count" as HashedKey;
      const opts = makeOptions();
      const fetcher = makeFetcher("count-data", 200);

      const obA = makeObserver(key);
      const obB = makeObserver(key);

      store.attachObserver(key, obA, opts);
      store.attachObserver(key, obB, opts);

      store.ensureFetch(key, "/api/count", fetcher);

      // Access inflight entry to verify observerCount
      // We use getCache as a proxy -- but we need the inflight entry
      // The pseudocode stores inflight in inflightMap
      // We verify through ensureFetch behavior: both observers get status updates
      expect(obA.onFetchStatusChange).toHaveBeenCalledWith("fetching");
      expect(obB.onFetchStatusChange).toHaveBeenCalledWith("fetching");

      // Detach one observer while in-flight
      store.detachObserver(key, obB);

      // Complete the fetch
      await vi.advanceTimersByTimeAsync(200);

      // Only obA should receive data (obB was detached)
      expect(obA.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "count-data" }));
      // obB should NOT receive data after detach
      expect(obB.onData).not.toHaveBeenCalled();
    });

    it("when 2 observers exist and inflight is active, both get status broadcasts", () => {
      const key = "s:/api/dual" as HashedKey;
      const opts = makeOptions();
      const fetcher = makeFetcher("dual-data", 500);

      const obA = makeObserver(key);
      const obB = makeObserver(key);

      store.attachObserver(key, obA, opts);
      store.attachObserver(key, obB, opts);

      store.ensureFetch(key, "/api/dual", fetcher);

      // Both observers should have received the "fetching" broadcast
      expect(obA.onFetchStatusChange).toHaveBeenCalledWith("fetching");
      expect(obB.onFetchStatusChange).toHaveBeenCalledWith("fetching");

      // Verify both are tracked: a third ensureFetch joins without new call
      const obC = makeObserver(key);
      store.attachObserver(key, obC, opts);
      store.ensureFetch(key, "/api/dual", fetcher);

      // Still only 1 fetch
      expect(fetcher).toHaveBeenCalledTimes(1);
      // obC also gets the fetching broadcast from ensureFetch join
      expect(obC.onFetchStatusChange).toHaveBeenCalledWith("fetching");
    });

    it("detaching all observers during in-flight aborts the fetch", async () => {
      const key = "s:/api/abort" as HashedKey;
      const opts = makeOptions();
      const fetcher = makeFetcher("abort-data", 200);

      const obA = makeObserver(key);
      const obB = makeObserver(key);

      store.attachObserver(key, obA, opts);
      store.attachObserver(key, obB, opts);

      store.ensureFetch(key, "/api/abort", fetcher);

      // Detach all observers
      store.detachObserver(key, obA);
      store.detachObserver(key, obB);

      // Let the timer run -- fetch should have been aborted
      await vi.advanceTimersByTimeAsync(200);

      // Neither observer should receive data (aborted before completion)
      expect(obA.onData).not.toHaveBeenCalled();
      expect(obB.onData).not.toHaveBeenCalled();

      // Cache should be empty since the fetch was aborted
      expect(store.getCache(key)).toBeNull();
    });
  });
});
