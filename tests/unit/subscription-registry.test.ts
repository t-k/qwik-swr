import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SWRError, SubscriptionStatus } from "../../src/types/index.ts";

// Will import from production code once created
import {
  subscriptionRegistry,
  type SubscriptionObserver,
} from "../../src/subscription/subscription-registry.ts";

// ═══════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════

function makeObserver(id: string): SubscriptionObserver & {
  dataHistory: unknown[];
  errorHistory: SWRError[];
  statusHistory: SubscriptionStatus[];
} {
  const dataHistory: unknown[] = [];
  const errorHistory: SWRError[] = [];
  const statusHistory: SubscriptionStatus[] = [];

  return {
    id,
    onData: vi.fn((data: unknown) => {
      dataHistory.push(data);
    }),
    onError: vi.fn((error: SWRError) => {
      errorHistory.push(error);
    }),
    onStatusChange: vi.fn((status: SubscriptionStatus) => {
      statusHistory.push(status);
    }),
    dataHistory,
    errorHistory,
    statusHistory,
  };
}

function makeSubscriberFn() {
  let capturedOnData: ((data: unknown) => void) | undefined;
  let capturedOnError: ((error: Error) => void) | undefined;
  const unsubscribe = vi.fn();

  const fn = vi.fn(
    (
      _key: string,
      callbacks: { onData: (data: unknown) => void; onError: (error: Error) => void },
    ) => {
      capturedOnData = callbacks.onData;
      capturedOnError = callbacks.onError;
      return { unsubscribe };
    },
  );

  return {
    fn,
    get capturedOnData() {
      return capturedOnData;
    },
    get capturedOnError() {
      return capturedOnError;
    },
    unsubscribe,
  };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("SubscriptionRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    subscriptionRegistry._reset();
  });

  afterEach(() => {
    subscriptionRegistry._reset();
    vi.useRealTimers();
  });

  // ─── attach: first observer creates connection ───

  describe("attach", () => {
    it("should create a new connection for the first observer", async () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // subscriberFn should be called once
      expect(sub.fn).toHaveBeenCalledTimes(1);
      expect(sub.fn).toHaveBeenCalledWith(
        "ws-key",
        expect.objectContaining({
          onData: expect.any(Function),
          onError: expect.any(Function),
        }),
      );

      expect(subscriptionRegistry._getConnectionCount()).toBe(1);
      expect(subscriptionRegistry._getObserverCount("s:ws-key")).toBe(1);
    });

    it("should share connection for the second observer with the same key", async () => {
      const observer1 = makeObserver("obs-1");
      const observer2 = makeObserver("obs-2");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer1, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });
      subscriptionRegistry.attach("s:ws-key", "ws-key", observer2, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // subscriberFn should only be called once (shared connection)
      expect(sub.fn).toHaveBeenCalledTimes(1);
      expect(subscriptionRegistry._getConnectionCount()).toBe(1);
      expect(subscriptionRegistry._getObserverCount("s:ws-key")).toBe(2);
    });

    it("should create separate connections for different keys", async () => {
      const observer1 = makeObserver("obs-1");
      const observer2 = makeObserver("obs-2");
      const sub1 = makeSubscriberFn();
      const sub2 = makeSubscriberFn();

      subscriptionRegistry.attach("s:key-a", "key-a", observer1, sub1.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });
      subscriptionRegistry.attach("s:key-b", "key-b", observer2, sub2.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      expect(sub1.fn).toHaveBeenCalledTimes(1);
      expect(sub2.fn).toHaveBeenCalledTimes(1);
      expect(subscriptionRegistry._getConnectionCount()).toBe(2);
    });
  });

  // ─── Broadcast: data dispatched to all observers ───

  describe("broadcast", () => {
    it("should broadcast data to all observers for the same key", async () => {
      const observer1 = makeObserver("obs-1");
      const observer2 = makeObserver("obs-2");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer1, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });
      subscriptionRegistry.attach("s:ws-key", "ws-key", observer2, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Simulate data from the shared connection
      sub.capturedOnData!({ message: "hello" });

      expect(observer1.onData).toHaveBeenCalledWith({ message: "hello" });
      expect(observer2.onData).toHaveBeenCalledWith({ message: "hello" });
    });

    it("should broadcast errors to all observers", async () => {
      const observer1 = makeObserver("obs-1");
      const observer2 = makeObserver("obs-2");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer1, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });
      subscriptionRegistry.attach("s:ws-key", "ws-key", observer2, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      sub.capturedOnError!(new Error("connection lost"));

      expect(observer1.onError).toHaveBeenCalledTimes(1);
      expect(observer2.onError).toHaveBeenCalledTimes(1);
    });

    it("should broadcast status changes to all observers", async () => {
      const observer1 = makeObserver("obs-1");
      const observer2 = makeObserver("obs-2");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer1, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });
      subscriptionRegistry.attach("s:ws-key", "ws-key", observer2, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Trigger data to transition to "live"
      sub.capturedOnData!("data");

      // Both should have received "connecting" then "live"
      expect(observer1.onStatusChange).toHaveBeenCalledWith("live");
      expect(observer2.onStatusChange).toHaveBeenCalledWith("live");
    });
  });

  // ─── Late joiner: receives latestData immediately ───

  describe("late joiner", () => {
    it("should deliver latestData to a late-joining observer", async () => {
      const observer1 = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer1, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Emit data
      sub.capturedOnData!("initial-data");

      // Late joiner
      const observer2 = makeObserver("obs-2");
      subscriptionRegistry.attach("s:ws-key", "ws-key", observer2, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // observer2 should receive latestData immediately
      expect(observer2.onData).toHaveBeenCalledWith("initial-data");
      expect(observer2.onStatusChange).toHaveBeenCalledWith("live");
    });

    it("should deliver latestError to a late-joining observer", async () => {
      const observer1 = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer1, sub.fn, {
        maxRetries: 10,
        retryInterval: 1000,
      });

      // Emit error (but still within retry limit)
      sub.capturedOnError!(new Error("connection lost"));

      // Late joiner
      const observer2 = makeObserver("obs-2");
      subscriptionRegistry.attach("s:ws-key", "ws-key", observer2, sub.fn, {
        maxRetries: 10,
        retryInterval: 1000,
      });

      // observer2 should receive the current status
      expect(observer2.onError).toHaveBeenCalledTimes(1);
      expect(observer2.onStatusChange).toHaveBeenCalledWith("connecting");
    });

    it("should not deliver latestData if none has been received", async () => {
      const observer1 = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer1, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // No data emitted yet

      // Late joiner
      const observer2 = makeObserver("obs-2");
      subscriptionRegistry.attach("s:ws-key", "ws-key", observer2, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // observer2 should only receive status, not data (since none exists)
      expect(observer2.onData).not.toHaveBeenCalled();
      // Should receive current status ("connecting")
      expect(observer2.onStatusChange).toHaveBeenCalledWith("connecting");
    });
  });

  // ─── detach ───

  describe("detach", () => {
    it("should keep connection alive when some observers remain", async () => {
      const observer1 = makeObserver("obs-1");
      const observer2 = makeObserver("obs-2");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer1, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });
      subscriptionRegistry.attach("s:ws-key", "ws-key", observer2, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      subscriptionRegistry.detach("s:ws-key", "obs-1");

      expect(subscriptionRegistry._getObserverCount("s:ws-key")).toBe(1);
      expect(subscriptionRegistry._getConnectionCount()).toBe(1);
      expect(sub.unsubscribe).not.toHaveBeenCalled();

      // Remaining observer should still receive data
      sub.capturedOnData!("after-detach");
      expect(observer2.onData).toHaveBeenCalledWith("after-detach");
      expect(observer1.onData).not.toHaveBeenCalledWith("after-detach");
    });

    it("should close connection when last observer is detached", async () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      subscriptionRegistry.detach("s:ws-key", "obs-1");

      expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
      expect(subscriptionRegistry._getConnectionCount()).toBe(0);
      expect(subscriptionRegistry._getObserverCount("s:ws-key")).toBe(0);
    });

    it("should clear retry timer when last observer detaches", async () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Trigger error to start retry timer
      sub.capturedOnError!(new Error("fail"));

      // Detach last observer
      subscriptionRegistry.detach("s:ws-key", "obs-1");

      expect(sub.unsubscribe).toHaveBeenCalled();
      expect(subscriptionRegistry._getConnectionCount()).toBe(0);

      // Advance time past retry - should not crash (timer cleared)
      await vi.advanceTimersByTimeAsync(5000);
    });

    it("should be a no-op for unknown keys", () => {
      // Should not throw
      subscriptionRegistry.detach("s:unknown-key", "obs-1");
      expect(subscriptionRegistry._getConnectionCount()).toBe(0);
    });

    it("should be a no-op for unknown observer ids", () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Detach with wrong id
      subscriptionRegistry.detach("s:ws-key", "obs-unknown");

      expect(subscriptionRegistry._getObserverCount("s:ws-key")).toBe(1);
      expect(sub.unsubscribe).not.toHaveBeenCalled();
    });
  });

  // ─── config conflict: first-writer-wins ───

  describe("config conflict", () => {
    it("should use first observer's config (first-writer-wins)", async () => {
      const observer1 = makeObserver("obs-1");
      const observer2 = makeObserver("obs-2");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer1, sub.fn, {
        maxRetries: 5,
        retryInterval: 2000,
      });
      subscriptionRegistry.attach("s:ws-key", "ws-key", observer2, sub.fn, {
        maxRetries: 10,
        retryInterval: 500,
      });

      // subscriberFn called only once (with first config)
      expect(sub.fn).toHaveBeenCalledTimes(1);
      // Connection count should be 1 (shared)
      expect(subscriptionRegistry._getConnectionCount()).toBe(1);
    });
  });

  // ─── reconnect ───

  describe("reconnect", () => {
    it("should reconnect and notify all observers", async () => {
      const observer1 = makeObserver("obs-1");
      const observer2 = makeObserver("obs-2");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer1, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });
      subscriptionRegistry.attach("s:ws-key", "ws-key", observer2, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Reconnect
      await subscriptionRegistry.reconnect("s:ws-key");

      // subscriberFn should be called again (reconnect)
      expect(sub.fn).toHaveBeenCalledTimes(2);

      // Both observers should get "connecting" status
      expect(observer1.onStatusChange).toHaveBeenCalledWith("connecting");
      expect(observer2.onStatusChange).toHaveBeenCalledWith("connecting");
    });

    it("should be a no-op for unknown keys", async () => {
      // Should not throw
      await subscriptionRegistry.reconnect("s:unknown-key");
    });

    it("should call unsubFn from previous connection before reconnecting", async () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      const firstUnsubscribe = sub.unsubscribe;

      await subscriptionRegistry.reconnect("s:ws-key");

      expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it("should reset retryCount on reconnect", async () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Trigger errors to increase retryCount
      sub.capturedOnError!(new Error("err1"));
      sub.capturedOnError!(new Error("err2"));

      // Reconnect should reset
      await subscriptionRegistry.reconnect("s:ws-key");

      // After reconnect, new data should work normally
      sub.capturedOnData!("recovered");
      expect(observer.onData).toHaveBeenCalledWith("recovered");
      expect(observer.onStatusChange).toHaveBeenCalledWith("live");
    });
  });

  // ─── getStatus ───

  describe("getStatus", () => {
    it("should return current status for a known key", () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      expect(subscriptionRegistry.getStatus("s:ws-key")).toBe("connecting");

      sub.capturedOnData!("data");
      expect(subscriptionRegistry.getStatus("s:ws-key")).toBe("live");
    });

    it("should return null for unknown key", () => {
      expect(subscriptionRegistry.getStatus("s:unknown")).toBeNull();
    });
  });

  // ─── retry logic ───

  describe("retry", () => {
    it("should retry with exponential backoff on error", async () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      expect(sub.fn).toHaveBeenCalledTimes(1);

      // Error #1: delay = 1000ms * 2^0 = 1000ms
      sub.capturedOnError!(new Error("err1"));

      await vi.advanceTimersByTimeAsync(999);
      expect(sub.fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sub.fn).toHaveBeenCalledTimes(2);
    });

    it("should disconnect after exceeding maxRetries", async () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 2,
        retryInterval: 1000,
      });

      // Error #1: retry 1
      sub.capturedOnError!(new Error("err1"));
      // Error #2: retry 2
      sub.capturedOnError!(new Error("err2"));
      // Error #3: exceeds maxRetries(2) -> disconnected
      sub.capturedOnError!(new Error("err3"));

      expect(observer.onStatusChange).toHaveBeenCalledWith("disconnected");
      expect(subscriptionRegistry.getStatus("s:ws-key")).toBe("disconnected");
    });
  });

  // ─── async subscriber ───

  describe("async subscriber", () => {
    it("should handle async subscriberFn that returns Promise", async () => {
      const observer = makeObserver("obs-1");
      const unsubscribe = vi.fn();
      let capturedOnData: ((data: unknown) => void) | undefined;

      const asyncSubscriberFn = vi.fn(
        (
          _key: string,
          callbacks: { onData: (data: unknown) => void; onError: (error: Error) => void },
        ) => {
          capturedOnData = callbacks.onData;
          return Promise.resolve({ unsubscribe });
        },
      );

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, asyncSubscriberFn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Let the promise resolve
      await vi.advanceTimersByTimeAsync(0);

      capturedOnData!("async-data");
      expect(observer.onData).toHaveBeenCalledWith("async-data");
    });
  });

  // ─── _reset ───

  describe("_reset", () => {
    it("should clear all connections and observers", async () => {
      const observer1 = makeObserver("obs-1");
      const observer2 = makeObserver("obs-2");
      const sub1 = makeSubscriberFn();
      const sub2 = makeSubscriberFn();

      subscriptionRegistry.attach("s:key-a", "key-a", observer1, sub1.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });
      subscriptionRegistry.attach("s:key-b", "key-b", observer2, sub2.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      expect(subscriptionRegistry._getConnectionCount()).toBe(2);

      subscriptionRegistry._reset();

      expect(subscriptionRegistry._getConnectionCount()).toBe(0);
      expect(subscriptionRegistry._getObserverCount("s:key-a")).toBe(0);
      expect(subscriptionRegistry._getObserverCount("s:key-b")).toBe(0);
    });

    it("should call unsubscribe for all active connections on reset", async () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      subscriptionRegistry._reset();

      expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  // ─── subscriberFn throws ───

  describe("subscriberFn throws synchronously", () => {
    it("should handle subscriberFn throw and schedule retry", async () => {
      const observer = makeObserver("obs-1");
      let callCount = 0;
      const subscriberFn = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error("connection refused");
        }
        return { unsubscribe: vi.fn() };
      });

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, subscriberFn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      expect(observer.onError).toHaveBeenCalledTimes(1);
      expect(observer.onStatusChange).toHaveBeenCalledWith("connecting");

      // Advance timer to trigger retry
      await vi.advanceTimersByTimeAsync(1000);
      expect(subscriberFn).toHaveBeenCalledTimes(2);
    });

    it("should disconnect after subscriberFn throws beyond maxRetries", async () => {
      const observer = makeObserver("obs-1");
      const subscriberFn = vi.fn(() => {
        throw new Error("always fails");
      });

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, subscriberFn, {
        maxRetries: 0,
        retryInterval: 1000,
      });

      // First throw sets retryCount to 1, which > maxRetries(0) -> disconnected
      expect(observer.onStatusChange).toHaveBeenCalledWith("disconnected");
    });
  });

  // ─── async subscriber reject ───

  describe("async subscriberFn that rejects", () => {
    it("should retry and eventually disconnect when async subscriberFn rejects", async () => {
      const observer = makeObserver("obs-1");
      let callCount = 0;

      const asyncSubscriberFn = vi.fn(
        (
          _key: string,
          _callbacks: { onData: (data: unknown) => void; onError: (error: Error) => void },
        ) => {
          callCount++;
          return Promise.reject(new Error(`async-fail-${callCount}`));
        },
      );

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, asyncSubscriberFn, {
        maxRetries: 2,
        retryInterval: 1000,
      });

      // Let the promise reject
      await vi.advanceTimersByTimeAsync(0);

      // Should have received error
      expect(observer.onError).toHaveBeenCalledTimes(1);

      // Should be in "connecting" state (retry pending)
      expect(observer.onStatusChange).toHaveBeenCalledWith("connecting");

      // Advance past first retry delay (1000ms * 2^0 = 1000ms)
      await vi.advanceTimersByTimeAsync(1000);
      // Let the second reject resolve
      await vi.advanceTimersByTimeAsync(0);
      expect(asyncSubscriberFn).toHaveBeenCalledTimes(2);

      // Advance past second retry delay (1000ms * 2^1 = 2000ms)
      await vi.advanceTimersByTimeAsync(2000);
      // Let the third reject resolve
      await vi.advanceTimersByTimeAsync(0);
      expect(asyncSubscriberFn).toHaveBeenCalledTimes(3);

      // retryCount is now 3 which > maxRetries(2) -> should disconnect
      expect(observer.onStatusChange).toHaveBeenCalledWith("disconnected");
    });

    it("should not hang when async subscriberFn rejects (must call retry logic)", async () => {
      const observer = makeObserver("obs-1");

      const asyncSubscriberFn = vi.fn(() => {
        return Promise.reject(new Error("immediate-reject"));
      });

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, asyncSubscriberFn, {
        maxRetries: 0,
        retryInterval: 1000,
      });

      // Let the promise reject
      await vi.advanceTimersByTimeAsync(0);

      // With maxRetries=0, should immediately disconnect
      expect(observer.onStatusChange).toHaveBeenCalledWith("disconnected");
      expect(observer.onError).toHaveBeenCalledTimes(1);
    });
  });

  // ─── connectionTimer race with onError ───

  describe("connectionTimer cleared on onError", () => {
    it("should clear connectionTimer when onError fires before timeout", async () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      // Use retryInterval > connectionTimeout gap so connectionTimer fires
      // BEFORE the retry's startConnection would clear it.
      // Timeline: connectionTimeout=3000, error at t=0, retryInterval=5000
      // Without fix: connectionTimer fires at t=3000 (before retry at t=5000)
      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 5,
        retryInterval: 5000,
        connectionTimeout: 3000,
      });

      expect(sub.fn).toHaveBeenCalledTimes(1);

      // Error fires immediately (before connectionTimeout of 3000)
      sub.capturedOnError!(new Error("connection lost"));

      // At t=3000: connectionTimer would fire if not cleared by onError.
      // This is BEFORE the retry (at t=5000) so startConnection can't save us.
      await vi.advanceTimersByTimeAsync(3000);

      // Observer should have received exactly 1 error (from onError)
      // NOT 2 errors (1 from onError + 1 from connectionTimer timeout)
      expect(observer.onError).toHaveBeenCalledTimes(1);

      // retryTimer fires at 5000ms (5000 * 2^0)
      await vi.advanceTimersByTimeAsync(2000);
      expect(sub.fn).toHaveBeenCalledTimes(2); // retry #1
    });

    it("should not double-retry when error occurs before connectionTimeout", async () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      // retryInterval (4000) > connectionTimeout (2000) so connectionTimer
      // would fire first if not cleared
      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 10,
        retryInterval: 4000,
        connectionTimeout: 2000,
      });

      expect(sub.fn).toHaveBeenCalledTimes(1);

      // Error at t=0 (immediate)
      sub.capturedOnError!(new Error("fail"));

      // At t=2000: connectionTimeout would fire if not cleared
      await vi.advanceTimersByTimeAsync(2000);

      // Should NOT have received a second error from connectionTimer
      expect(observer.onError).toHaveBeenCalledTimes(1);
      // subscriberFn should not have been called again yet (retry at t=4000)
      expect(sub.fn).toHaveBeenCalledTimes(1);

      // At t=4000: retryTimer fires
      await vi.advanceTimersByTimeAsync(2000);
      expect(sub.fn).toHaveBeenCalledTimes(2);
    });
  });

  // ─── retry timer duplication ───

  describe("retry timer duplication", () => {
    it("rapid errors should not create multiple retry timers", async () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 10,
        retryInterval: 1000,
      });

      expect(sub.fn).toHaveBeenCalledTimes(1);

      // Fire two rapid errors (before any retry timer fires)
      // err1: retryCount becomes 1, timer at 1000 * 2^0 = 1000ms
      // err2: retryCount becomes 2, timer at 1000 * 2^1 = 2000ms (first timer cleared)
      sub.capturedOnError!(new Error("err1"));
      sub.capturedOnError!(new Error("err2"));

      // At 1000ms: if first timer was NOT cleared, subscriberFn would fire.
      // With the fix, only the second timer exists (at 2000ms).
      await vi.advanceTimersByTimeAsync(1000);
      expect(sub.fn).toHaveBeenCalledTimes(1); // no retry yet

      // At 2000ms: the second (and only) timer fires
      await vi.advanceTimersByTimeAsync(1000);
      expect(sub.fn).toHaveBeenCalledTimes(2); // exactly 1 retry
    });
  });

  // ─── connection timeout ───

  describe("connection timeout (SF-1)", () => {
    it("should timeout if subscriberFn never calls callbacks within connectionTimeout", async () => {
      const observer = makeObserver("obs-1");
      // subscriberFn that connects but never calls onData (hangs in "connecting")
      const unsubscribe = vi.fn();
      const silentSubscriberFn = vi.fn(() => {
        return { unsubscribe };
      });

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, silentSubscriberFn, {
        maxRetries: 3,
        retryInterval: 1000,
        connectionTimeout: 5000,
      });

      expect(observer.onStatusChange).toHaveBeenCalledWith("connecting");

      // Advance past the connection timeout
      await vi.advanceTimersByTimeAsync(5000);

      // Should have received an error about timeout
      expect(observer.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("timeout"),
        }),
      );
    });

    it("should not timeout if data arrives before connectionTimeout", async () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
        connectionTimeout: 5000,
      });

      // Data arrives within timeout
      sub.capturedOnData!("hello");

      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(5000);

      // Should be live, no error
      expect(observer.onStatusChange).toHaveBeenCalledWith("live");
      expect(observer.onError).not.toHaveBeenCalled();
    });

    it("should set status to 'disconnected' on timeout when maxRetries exceeded", async () => {
      const observer = makeObserver("obs-1");
      const unsubscribe = vi.fn();
      const silentSubscriberFn = vi.fn(() => {
        return { unsubscribe };
      });

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, silentSubscriberFn, {
        maxRetries: 0,
        retryInterval: 1000,
        connectionTimeout: 2000,
      });

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(2000);

      // With maxRetries=0, retryCount=1 > 0 -> disconnected
      expect(observer.onStatusChange).toHaveBeenCalledWith("disconnected");
    });

    it("should attempt retry after timeout if retries remain", async () => {
      const observer = makeObserver("obs-1");
      let callCount = 0;
      const unsubscribe = vi.fn();
      const silentSubscriberFn = vi.fn(() => {
        callCount++;
        // Second call provides data
        if (callCount === 2) {
          // We need to simulate providing data on the next call
          // But since subscriberFn is sync and we can't trigger callbacks after return,
          // we'll just check that startConnection is called again
        }
        return { unsubscribe };
      });

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, silentSubscriberFn, {
        maxRetries: 3,
        retryInterval: 1000,
        connectionTimeout: 2000,
      });

      expect(silentSubscriberFn).toHaveBeenCalledTimes(1);

      // Timeout fires
      await vi.advanceTimersByTimeAsync(2000);

      // Retry delay: 1000ms * 2^0 = 1000ms
      await vi.advanceTimersByTimeAsync(1000);

      // Should have retried
      expect(silentSubscriberFn).toHaveBeenCalledTimes(2);
    });

    it("should not fire timeout when connectionTimeout is 0 (disabled)", async () => {
      const observer = makeObserver("obs-1");
      const unsubscribe = vi.fn();
      const silentSubscriberFn = vi.fn(() => {
        return { unsubscribe };
      });

      subscriptionRegistry.attach("s:ws-key", "ws-key", observer, silentSubscriberFn, {
        maxRetries: 3,
        retryInterval: 1000,
        connectionTimeout: 0,
      });

      // Advance a long time
      await vi.advanceTimersByTimeAsync(60000);

      // No error should have been triggered
      expect(observer.onError).not.toHaveBeenCalled();
      // Still connecting
      expect(subscriptionRegistry.getStatus("s:ws-key")).toBe("connecting");
    });
  });
});
