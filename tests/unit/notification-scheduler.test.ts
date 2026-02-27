import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CacheEntry, HashedKey, SWRError } from "../../src/types/index.ts";

describe("createNotificationScheduler", () => {
  let createNotificationScheduler: typeof import("../../src/cache/notification-scheduler.ts").createNotificationScheduler;

  beforeEach(async () => {
    const mod = await import("../../src/cache/notification-scheduler.ts");
    createNotificationScheduler = mod.createNotificationScheduler;
  });

  function makeObserver(id: string) {
    const calls = {
      data: [] as CacheEntry[],
      errors: [] as SWRError[],
      statuses: [] as string[],
    };
    return {
      observer: {
        id,
        hasData: false,
        onData: (entry: CacheEntry) => calls.data.push(entry),
        onError: (error: SWRError) => calls.errors.push(error),
        onFetchStatusChange: (status: "fetching" | "idle" | "paused") =>
          calls.statuses.push(status),
      },
      calls,
    };
  }

  describe("microtask scheduling (interval=0)", () => {
    it("should batch multiple enqueueData calls into a single flush", async () => {
      const { observer, calls } = makeObserver("ob1");
      const observers = new Map<HashedKey, ReadonlySet<typeof observer>>();
      observers.set("s:key1" as HashedKey, new Set([observer]));

      const scheduler = createNotificationScheduler(0, (key) => observers.get(key));

      // Enqueue 10 updates for the same key
      for (let i = 0; i < 10; i++) {
        scheduler.enqueueData("s:key1" as HashedKey, { data: `v${i}`, timestamp: i });
      }

      // Not yet flushed (microtask not executed)
      expect(calls.data).toHaveLength(0);

      // Wait for microtask
      await Promise.resolve();

      // Should only receive the last value (same-key dedup)
      expect(calls.data).toHaveLength(1);
      expect(calls.data[0]!.data).toBe("v9");

      scheduler._reset();
    });

    it("should deliver different keys in a single flush", async () => {
      const { observer: ob1, calls: calls1 } = makeObserver("ob1");
      const { observer: ob2, calls: calls2 } = makeObserver("ob2");
      const observers = new Map<HashedKey, ReadonlySet<typeof ob1>>();
      observers.set("s:k1" as HashedKey, new Set([ob1]));
      observers.set("s:k2" as HashedKey, new Set([ob2]));

      const scheduler = createNotificationScheduler(0, (key) => observers.get(key));

      scheduler.enqueueData("s:k1" as HashedKey, { data: "a", timestamp: 1 });
      scheduler.enqueueData("s:k2" as HashedKey, { data: "b", timestamp: 2 });

      await Promise.resolve();

      expect(calls1.data).toHaveLength(1);
      expect(calls1.data[0]!.data).toBe("a");
      expect(calls2.data).toHaveLength(1);
      expect(calls2.data[0]!.data).toBe("b");

      scheduler._reset();
    });

    it("should batch enqueueError similarly", async () => {
      const { observer, calls } = makeObserver("ob1");
      const observers = new Map<HashedKey, ReadonlySet<typeof observer>>();
      observers.set("s:key1" as HashedKey, new Set([observer]));

      const scheduler = createNotificationScheduler(0, (key) => observers.get(key));

      const err: SWRError = {
        type: "network",
        message: "fail",
        retryCount: 0,
        timestamp: 100,
      };
      scheduler.enqueueError("s:key1" as HashedKey, err);

      await Promise.resolve();

      expect(calls.errors).toHaveLength(1);
      expect(calls.errors[0]!.message).toBe("fail");

      scheduler._reset();
    });

    it("should batch enqueueFetchStatus", async () => {
      const { observer, calls } = makeObserver("ob1");
      const observers = new Map<HashedKey, ReadonlySet<typeof observer>>();
      observers.set("s:key1" as HashedKey, new Set([observer]));

      const scheduler = createNotificationScheduler(0, (key) => observers.get(key));

      scheduler.enqueueFetchStatus("s:key1" as HashedKey, "fetching");
      scheduler.enqueueFetchStatus("s:key1" as HashedKey, "idle");

      await Promise.resolve();

      // Last status wins
      expect(calls.statuses).toHaveLength(1);
      expect(calls.statuses[0]).toBe("idle");

      scheduler._reset();
    });
  });

  describe("setTimeout scheduling (interval>0)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should batch within setTimeout interval", () => {
      const { observer, calls } = makeObserver("ob1");
      const observers = new Map<HashedKey, ReadonlySet<typeof observer>>();
      observers.set("s:key1" as HashedKey, new Set([observer]));

      const scheduler = createNotificationScheduler(16, (key) => observers.get(key));

      scheduler.enqueueData("s:key1" as HashedKey, { data: "v1", timestamp: 1 });
      scheduler.enqueueData("s:key1" as HashedKey, { data: "v2", timestamp: 2 });

      // Not yet flushed
      expect(calls.data).toHaveLength(0);

      vi.advanceTimersByTime(16);

      // Flushed with latest value
      expect(calls.data).toHaveLength(1);
      expect(calls.data[0]!.data).toBe("v2");

      scheduler._reset();
    });
  });

  describe("flush()", () => {
    it("should force immediate delivery of pending notifications", () => {
      const { observer, calls } = makeObserver("ob1");
      const observers = new Map<HashedKey, ReadonlySet<typeof observer>>();
      observers.set("s:key1" as HashedKey, new Set([observer]));

      const scheduler = createNotificationScheduler(0, (key) => observers.get(key));

      scheduler.enqueueData("s:key1" as HashedKey, { data: "immediate", timestamp: 1 });

      // Force flush without waiting for microtask
      scheduler.flush();

      expect(calls.data).toHaveLength(1);
      expect(calls.data[0]!.data).toBe("immediate");

      scheduler._reset();
    });
  });

  describe("edge cases", () => {
    it("should skip keys with no observers at flush time", async () => {
      const observers = new Map<HashedKey, ReadonlySet<any>>();
      // No observer registered for this key

      const scheduler = createNotificationScheduler(0, (key) => observers.get(key));

      scheduler.enqueueData("s:orphan" as HashedKey, { data: "lost", timestamp: 1 });

      // Should not throw
      await Promise.resolve();

      scheduler._reset();
    });

    it("should handle _reset clearing all pending state", async () => {
      const { observer, calls } = makeObserver("ob1");
      const observers = new Map<HashedKey, ReadonlySet<typeof observer>>();
      observers.set("s:key1" as HashedKey, new Set([observer]));

      const scheduler = createNotificationScheduler(0, (key) => observers.get(key));

      scheduler.enqueueData("s:key1" as HashedKey, { data: "pending", timestamp: 1 });
      scheduler._reset();

      await Promise.resolve();

      // Should not receive anything after reset
      expect(calls.data).toHaveLength(0);

      scheduler._reset();
    });

    it("should handle multiple flushes correctly", async () => {
      const { observer, calls } = makeObserver("ob1");
      const observers = new Map<HashedKey, ReadonlySet<typeof observer>>();
      observers.set("s:key1" as HashedKey, new Set([observer]));

      const scheduler = createNotificationScheduler(0, (key) => observers.get(key));

      // First batch
      scheduler.enqueueData("s:key1" as HashedKey, { data: "batch1", timestamp: 1 });
      await Promise.resolve();
      expect(calls.data).toHaveLength(1);

      // Second batch
      scheduler.enqueueData("s:key1" as HashedKey, { data: "batch2", timestamp: 2 });
      await Promise.resolve();
      expect(calls.data).toHaveLength(2);
      expect(calls.data[1]!.data).toBe("batch2");

      scheduler._reset();
    });
  });
});
