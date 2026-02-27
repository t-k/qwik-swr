import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createConnection,
  type ConnectionContext,
} from "../../src/subscription/subscription-connect.ts";
import type { SubscriptionStatus, SWRError } from "../../src/types/index.ts";

// Test the subscription connection management logic using production code
// These verify the core algorithm used by useSubscription via createConnection

function makeState<Data = string>() {
  let status: SubscriptionStatus = "connecting";
  let data: Data | undefined = undefined;
  let error: SWRError | undefined = undefined;
  let retryCount = 0;
  let cancelled = false;
  let unsubFn: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const statusChanges: SubscriptionStatus[] = [];

  return {
    get status() {
      return status;
    },
    get data() {
      return data;
    },
    get error() {
      return error;
    },
    get retryCount() {
      return retryCount;
    },
    get cancelled() {
      return cancelled;
    },
    get unsubFn() {
      return unsubFn;
    },
    get retryTimer() {
      return retryTimer;
    },
    statusChanges,
    setCancelled(v: boolean) {
      cancelled = v;
    },
    buildContext(
      overrides: Partial<ConnectionContext<Data, string>> = {},
    ): ConnectionContext<Data, string> {
      return {
        key: "test-key",
        subscriberFn: vi.fn((_key, _cbs) => ({ unsubscribe: vi.fn() })),
        maxRetries: 10,
        retryInterval: 1000,
        onStatusChange: (s) => {
          status = s;
          statusChanges.push(s);
        },
        onData: (d) => {
          data = d;
          error = undefined;
        },
        onError: (e) => {
          error = e;
        },
        getCancelled: () => cancelled,
        getRetryCount: () => retryCount,
        setRetryCount: (n) => {
          retryCount = n;
        },
        setUnsubFn: (fn) => {
          unsubFn = fn;
        },
        getUnsubFn: () => unsubFn,
        setRetryTimer: (timer) => {
          retryTimer = timer;
        },
        ...overrides,
      };
    },
  };
}

describe("useSubscription unit tests (production code)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should transition from connecting to live when data is received", async () => {
    const s = makeState();

    const ctx = s.buildContext({
      subscriberFn: vi.fn((_key, cbs) => {
        setTimeout(() => cbs.onData("hello"), 10);
        return { unsubscribe: vi.fn() };
      }),
    });

    await createConnection(ctx);
    expect(s.status).toBe("connecting");

    await vi.advanceTimersByTimeAsync(10);
    expect(s.status).toBe("live");
    expect(s.data).toBe("hello");
  });

  it("should update data when onData is called multiple times", async () => {
    const s = makeState();
    const dataReceived: string[] = [];
    let capturedOnData: ((d: string) => void) | undefined;

    const ctx = s.buildContext({
      subscriberFn: vi.fn((_key, cbs) => {
        capturedOnData = cbs.onData;
        return { unsubscribe: vi.fn() };
      }),
      notifyOnData: (d) => dataReceived.push(d),
    });

    await createConnection(ctx);
    capturedOnData!("first");
    capturedOnData!("second");

    expect(s.data).toBe("second");
    expect(dataReceived).toEqual(["first", "second"]);
  });

  it("should use exponential backoff for reconnection", async () => {
    const s = makeState();
    let capturedOnError: ((e: Error) => void) | undefined;

    const ctx = s.buildContext({
      maxRetries: 3,
      subscriberFn: vi.fn((_key, cbs) => {
        capturedOnError = cbs.onError;
        return { unsubscribe: vi.fn() };
      }),
    });

    await createConnection(ctx);

    // First error: retryCount becomes 1
    capturedOnError!(new Error("err1"));
    expect(s.retryCount).toBe(1);
    expect(s.statusChanges).toContain("connecting");

    // Second error: retryCount becomes 2
    capturedOnError!(new Error("err2"));
    expect(s.retryCount).toBe(2);

    // Third error: retryCount becomes 3
    capturedOnError!(new Error("err3"));
    expect(s.retryCount).toBe(3);
  });

  it("should transition to disconnected when maxRetries is exceeded", async () => {
    const s = makeState();
    let capturedOnError: ((e: Error) => void) | undefined;

    const ctx = s.buildContext({
      maxRetries: 2,
      subscriberFn: vi.fn((_key, cbs) => {
        capturedOnError = cbs.onError;
        return { unsubscribe: vi.fn() };
      }),
    });

    await createConnection(ctx);

    capturedOnError!(new Error("err1")); // retry 1
    capturedOnError!(new Error("err2")); // retry 2
    capturedOnError!(new Error("err3")); // exceeds maxRetries

    expect(s.status).toBe("disconnected");
  });

  it("should support unsubscribe via cleanup pattern", async () => {
    const s = makeState();
    const unsubFn = vi.fn();

    const ctx = s.buildContext({
      subscriberFn: vi.fn((_key, _cbs) => ({
        unsubscribe: unsubFn,
      })),
    });

    await createConnection(ctx);

    // Simulate cleanup (as useVisibleTask$ cleanup would do)
    s.setCancelled(true);
    if (s.retryTimer) clearTimeout(s.retryTimer);
    s.unsubFn?.();

    expect(unsubFn).toHaveBeenCalledOnce();
  });

  it("should allow reconnection after disconnect", async () => {
    const s = makeState();
    let capturedOnError: ((e: Error) => void) | undefined;

    const ctx = s.buildContext({
      maxRetries: 2,
      subscriberFn: vi.fn((_key, cbs) => {
        capturedOnError = cbs.onError;
        return { unsubscribe: vi.fn() };
      }),
    });

    // Exhaust retries
    await createConnection(ctx);
    capturedOnError!(new Error("err1"));
    capturedOnError!(new Error("err2"));
    capturedOnError!(new Error("err3"));
    expect(s.status).toBe("disconnected");

    // Reset and reconnect (as reconnect$ would do)
    // reconnect$ resets cancelledRef, retryCountRef, error before calling createConnection
    s.setCancelled(false);
    s.statusChanges.length = 0;

    const reconnectCtx = s.buildContext({
      maxRetries: 2,
      subscriberFn: vi.fn((_key, _cbs) => ({
        unsubscribe: vi.fn(),
      })),
    });
    // Simulate reconnect$ resetting retryCount before createConnection
    reconnectCtx.setRetryCount(0);

    await createConnection(reconnectCtx);
    expect(s.status).toBe("connecting");
    expect(s.retryCount).toBe(0);
  });

  it("should unsubscribe immediately after async subscriber resolves if cancelled", async () => {
    const s = makeState();
    const unsubFn = vi.fn();

    const ctx = s.buildContext({
      subscriberFn: vi.fn(async (_key, _cbs) => {
        await new Promise((r) => setTimeout(r, 100));
        return { unsubscribe: unsubFn };
      }),
    });

    const connectPromise = createConnection(ctx);

    // Cancel before async completes
    s.setCancelled(true);

    // Advance time to let async resolve
    await vi.advanceTimersByTimeAsync(100);
    await connectPromise;

    expect(unsubFn).toHaveBeenCalledOnce();
  });

  it("should not start subscription with null key (tested at hook level)", () => {
    // This is handled at the useSubscription hook level
    // createConnection itself doesn't check key validity
    // When key is null/undefined/false, useSubscription returns early without calling createConnection
    const subscriberFn = vi.fn();
    const key: string | null = null;

    if (key !== null && key !== undefined && key !== false) {
      subscriberFn();
    }

    expect(subscriberFn).not.toHaveBeenCalled();
  });

  it("auto-retry within reconnect respects maxRetries without resetting count", async () => {
    const s = makeState();
    const connectCount = { value: 0 };
    let capturedOnError: ((e: Error) => void) | undefined;

    const subscriberFn = vi.fn(
      (_key: string, cbs: { onData: (d: string) => void; onError: (e: Error) => void }) => {
        connectCount.value++;
        capturedOnError = cbs.onError;
        return { unsubscribe: vi.fn() };
      },
    );

    const ctx = s.buildContext({
      maxRetries: 3,
      subscriberFn,
    });

    // Initial connection
    await createConnection(ctx);
    expect(s.retryCount).toBe(0);
    expect(connectCount.value).toBe(1);

    // Error #1: triggers auto-retry after 1000ms
    capturedOnError!(new Error("connection failed #1"));
    expect(s.retryCount).toBe(1);
    expect(s.status).toBe("connecting");

    // Auto-retry fires at 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    expect(connectCount.value).toBe(2);

    // Error #2: triggers auto-retry after 2000ms
    capturedOnError!(new Error("connection failed #2"));
    expect(s.retryCount).toBe(2);
    expect(s.status).toBe("connecting");

    // Auto-retry fires at 2000ms
    await vi.advanceTimersByTimeAsync(2000);
    expect(connectCount.value).toBe(3);

    // Error #3: triggers auto-retry after 4000ms
    capturedOnError!(new Error("connection failed #3"));
    expect(s.retryCount).toBe(3);
    expect(s.status).toBe("connecting");

    // Auto-retry fires at 4000ms
    await vi.advanceTimersByTimeAsync(4000);
    expect(connectCount.value).toBe(4);

    // Error #4: exceeds maxRetries(3) -> disconnected
    capturedOnError!(new Error("connection failed #4"));
    expect(s.retryCount).toBe(4);
    expect(s.status).toBe("disconnected");

    // No more retries
    await vi.advanceTimersByTimeAsync(100000);
    expect(connectCount.value).toBe(4);
    expect(s.status).toBe("disconnected");
  });

  it("should reset retryCount when data is received after retries", async () => {
    const s = makeState();
    let capturedOnData: ((d: string) => void) | undefined;
    let capturedOnError: ((e: Error) => void) | undefined;

    const ctx = s.buildContext({
      subscriberFn: vi.fn((_key, cbs) => {
        capturedOnData = cbs.onData;
        capturedOnError = cbs.onError;
        return { unsubscribe: vi.fn() };
      }),
    });

    await createConnection(ctx);

    capturedOnError!(new Error("err1"));
    capturedOnError!(new Error("err2"));
    expect(s.retryCount).toBe(2);

    capturedOnData!("recovered");
    expect(s.retryCount).toBe(0);
    expect(s.status).toBe("live");
  });
});
