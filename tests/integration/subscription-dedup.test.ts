import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SWRError, SubscriptionStatus } from "../../src/types/index.ts";
import { subscriptionRegistry } from "../../src/subscription/subscription-registry.ts";

// ═══════════════════════════════════════════════════════════════
// Integration tests: subscription connection deduplication
// ═══════════════════════════════════════════════════════════════

function makeObserver(id: string) {
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

describe("Subscription connection deduplication", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    subscriptionRegistry._reset();
  });

  afterEach(() => {
    subscriptionRegistry._reset();
    vi.useRealTimers();
  });

  it("subscriberFn is called only once for 3 observers on the same key", () => {
    const unsubscribe = vi.fn();
    const subscriberFn = vi.fn(
      (
        _key: string,
        _callbacks: { onData: (data: unknown) => void; onError: (error: Error) => void },
      ) => {
        return { unsubscribe };
      },
    );

    const observer1 = makeObserver("obs-1");
    const observer2 = makeObserver("obs-2");
    const observer3 = makeObserver("obs-3");
    const config = { maxRetries: 3, retryInterval: 1000 };

    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer1, subscriberFn, config);
    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer2, subscriberFn, config);
    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer3, subscriberFn, config);

    // subscriberFn called exactly once
    expect(subscriberFn).toHaveBeenCalledTimes(1);

    // But 3 observers registered
    expect(subscriptionRegistry._getObserverCount("s:ws-topic")).toBe(3);
  });

  it("all observers receive data from the shared connection", () => {
    let capturedOnData: ((data: unknown) => void) | undefined;
    const subscriberFn = vi.fn(
      (
        _key: string,
        callbacks: { onData: (data: unknown) => void; onError: (error: Error) => void },
      ) => {
        capturedOnData = callbacks.onData;
        return { unsubscribe: vi.fn() };
      },
    );

    const observer1 = makeObserver("obs-1");
    const observer2 = makeObserver("obs-2");
    const observer3 = makeObserver("obs-3");
    const config = { maxRetries: 3, retryInterval: 1000 };

    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer1, subscriberFn, config);
    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer2, subscriberFn, config);
    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer3, subscriberFn, config);

    // Emit data
    capturedOnData!({ type: "message", payload: "hello" });

    // All 3 observers should receive the data
    expect(observer1.onData).toHaveBeenCalledWith({ type: "message", payload: "hello" });
    expect(observer2.onData).toHaveBeenCalledWith({ type: "message", payload: "hello" });
    expect(observer3.onData).toHaveBeenCalledWith({ type: "message", payload: "hello" });
  });

  it("unsubFn is called exactly once when last observer detaches", () => {
    const unsubscribe = vi.fn();
    const subscriberFn = vi.fn(
      (
        _key: string,
        _callbacks: { onData: (data: unknown) => void; onError: (error: Error) => void },
      ) => {
        return { unsubscribe };
      },
    );

    const observer1 = makeObserver("obs-1");
    const observer2 = makeObserver("obs-2");
    const observer3 = makeObserver("obs-3");
    const config = { maxRetries: 3, retryInterval: 1000 };

    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer1, subscriberFn, config);
    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer2, subscriberFn, config);
    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer3, subscriberFn, config);

    // Detach first two: connection stays alive
    subscriptionRegistry.detach("s:ws-topic", "obs-1");
    expect(unsubscribe).not.toHaveBeenCalled();

    subscriptionRegistry.detach("s:ws-topic", "obs-2");
    expect(unsubscribe).not.toHaveBeenCalled();

    // Detach last: connection is closed
    subscriptionRegistry.detach("s:ws-topic", "obs-3");
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    expect(subscriptionRegistry._getConnectionCount()).toBe(0);
  });

  it("detached observers stop receiving data", () => {
    let capturedOnData: ((data: unknown) => void) | undefined;
    const subscriberFn = vi.fn(
      (
        _key: string,
        callbacks: { onData: (data: unknown) => void; onError: (error: Error) => void },
      ) => {
        capturedOnData = callbacks.onData;
        return { unsubscribe: vi.fn() };
      },
    );

    const observer1 = makeObserver("obs-1");
    const observer2 = makeObserver("obs-2");
    const config = { maxRetries: 3, retryInterval: 1000 };

    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer1, subscriberFn, config);
    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer2, subscriberFn, config);

    // Detach observer1
    subscriptionRegistry.detach("s:ws-topic", "obs-1");

    // Emit data
    capturedOnData!("after-detach");

    // Only observer2 should receive
    expect(observer2.onData).toHaveBeenCalledWith("after-detach");
    // observer1 should NOT receive the post-detach data
    // It may have received "connecting" status on attach, but not this data
    const observer1DataCalls = (observer1.onData as any).mock.calls;
    const hasAfterDetach = observer1DataCalls.some((call: unknown[]) => call[0] === "after-detach");
    expect(hasAfterDetach).toBe(false);
  });

  it("late joiner receives latest data and all subsequent updates", () => {
    let capturedOnData: ((data: unknown) => void) | undefined;
    const subscriberFn = vi.fn(
      (
        _key: string,
        callbacks: { onData: (data: unknown) => void; onError: (error: Error) => void },
      ) => {
        capturedOnData = callbacks.onData;
        return { unsubscribe: vi.fn() };
      },
    );

    const observer1 = makeObserver("obs-1");
    const config = { maxRetries: 3, retryInterval: 1000 };

    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer1, subscriberFn, config);

    // First data
    capturedOnData!("first-message");

    // Late joiner
    const observer2 = makeObserver("obs-2");
    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer2, subscriberFn, config);

    // observer2 should immediately get latest data
    expect(observer2.dataHistory).toEqual(["first-message"]);

    // New data should go to both
    capturedOnData!("second-message");
    expect(observer1.dataHistory).toEqual(["first-message", "second-message"]);
    expect(observer2.dataHistory).toEqual(["first-message", "second-message"]);
  });

  it("multiple keys maintain independent connections", () => {
    let capturedOnDataA: ((data: unknown) => void) | undefined;
    let capturedOnDataB: ((data: unknown) => void) | undefined;
    const unsubA = vi.fn();
    const unsubB = vi.fn();

    const subscriberFnA = vi.fn(
      (
        _key: string,
        callbacks: { onData: (data: unknown) => void; onError: (error: Error) => void },
      ) => {
        capturedOnDataA = callbacks.onData;
        return { unsubscribe: unsubA };
      },
    );
    const subscriberFnB = vi.fn(
      (
        _key: string,
        callbacks: { onData: (data: unknown) => void; onError: (error: Error) => void },
      ) => {
        capturedOnDataB = callbacks.onData;
        return { unsubscribe: unsubB };
      },
    );

    const observerA = makeObserver("obs-a");
    const observerB = makeObserver("obs-b");
    const config = { maxRetries: 3, retryInterval: 1000 };

    subscriptionRegistry.attach("s:topic-a", "topic-a", observerA, subscriberFnA, config);
    subscriptionRegistry.attach("s:topic-b", "topic-b", observerB, subscriberFnB, config);

    // Data on topic-a should only go to observerA
    capturedOnDataA!("data-a");
    expect(observerA.onData).toHaveBeenCalledWith("data-a");
    expect(observerB.onData).not.toHaveBeenCalledWith("data-a");

    // Data on topic-b should only go to observerB
    capturedOnDataB!("data-b");
    expect(observerB.onData).toHaveBeenCalledWith("data-b");
    expect(observerA.onData).not.toHaveBeenCalledWith("data-b");

    // Detach one key: other stays alive
    subscriptionRegistry.detach("s:topic-a", "obs-a");
    expect(unsubA).toHaveBeenCalledTimes(1);
    expect(unsubB).not.toHaveBeenCalled();
    expect(subscriptionRegistry._getConnectionCount()).toBe(1);
  });

  it("reconnect re-creates connection while keeping all observers", async () => {
    let capturedOnData: ((data: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscriberFn = vi.fn(
      (
        _key: string,
        callbacks: { onData: (data: unknown) => void; onError: (error: Error) => void },
      ) => {
        capturedOnData = callbacks.onData;
        return { unsubscribe };
      },
    );

    const observer1 = makeObserver("obs-1");
    const observer2 = makeObserver("obs-2");
    const config = { maxRetries: 3, retryInterval: 1000 };

    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer1, subscriberFn, config);
    subscriptionRegistry.attach("s:ws-topic", "ws-topic", observer2, subscriberFn, config);

    // Reconnect
    await subscriptionRegistry.reconnect("s:ws-topic");

    // subscriberFn called 2 times (initial + reconnect)
    expect(subscriberFn).toHaveBeenCalledTimes(2);

    // Both observers still registered
    expect(subscriptionRegistry._getObserverCount("s:ws-topic")).toBe(2);

    // New data should go to both
    capturedOnData!("after-reconnect");
    expect(observer1.onData).toHaveBeenCalledWith("after-reconnect");
    expect(observer2.onData).toHaveBeenCalledWith("after-reconnect");
  });
});
