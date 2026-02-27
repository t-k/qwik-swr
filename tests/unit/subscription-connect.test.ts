import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createConnection,
  handleResult,
  buildConnectionContext,
  type ConnectionContext,
  type SubscriptionRefs,
  type SubscriptionState,
} from "../../src/subscription/subscription-connect.ts";
import type { SWRError, SubscriptionStatus } from "../../src/types/index.ts";

// ═══════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════

function makeContext<Data = string>(
  overrides: Partial<ConnectionContext<Data, string>> = {},
): ConnectionContext<Data, string> {
  let retryCount = 0;
  let cancelled = false;
  let unsubFn: (() => void) | null = null;
  let _retryTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    key: "/test",
    subscriberFn: vi.fn((_key, _callbacks) => ({
      unsubscribe: vi.fn(),
    })),
    maxRetries: 3,
    retryInterval: 1000,
    onStatusChange: vi.fn(),
    onData: vi.fn(),
    onError: vi.fn(),
    getCancelled: () => cancelled,
    getRetryCount: () => retryCount,
    setRetryCount: (n: number) => {
      retryCount = n;
    },
    setUnsubFn: (fn: (() => void) | null) => {
      unsubFn = fn;
    },
    getUnsubFn: () => unsubFn,
    setRetryTimer: (timer: ReturnType<typeof setTimeout> | null) => {
      _retryTimer = timer;
    },
    // Allow tests to control cancellation
    _setCancelled: (v: boolean) => {
      cancelled = v;
    },
    ...overrides,
  } as ConnectionContext<Data, string> & {
    _setCancelled: (v: boolean) => void;
  };
}

// ═══════════════════════════════════════════════════════════════
// T007: Connection success flow
// ═══════════════════════════════════════════════════════════════

describe("createConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("connection success flow", () => {
    it("should call subscriberFn with key and callbacks", async () => {
      const ctx = makeContext();
      await createConnection(ctx);

      expect(ctx.subscriberFn).toHaveBeenCalledWith(
        "/test",
        expect.objectContaining({
          onData: expect.any(Function),
          onError: expect.any(Function),
        }),
      );
    });

    it("should set status to connecting initially", async () => {
      const ctx = makeContext();
      await createConnection(ctx);

      expect(ctx.onStatusChange).toHaveBeenCalledWith("connecting");
    });

    it("should transition to live when onData is called", async () => {
      let capturedOnData: ((d: string) => void) | undefined;

      const ctx = makeContext({
        subscriberFn: vi.fn((_key, callbacks) => {
          capturedOnData = callbacks.onData;
          return { unsubscribe: vi.fn() };
        }),
      });

      await createConnection(ctx);
      capturedOnData!("hello");

      expect(ctx.onData).toHaveBeenCalledWith("hello");
      expect(ctx.onStatusChange).toHaveBeenCalledWith("live");
    });

    it("should reset retry count on data received", async () => {
      let capturedOnData: ((d: string) => void) | undefined;
      let retryCount = 2;

      const ctx = makeContext({
        subscriberFn: vi.fn((_key, callbacks) => {
          capturedOnData = callbacks.onData;
          return { unsubscribe: vi.fn() };
        }),
        getRetryCount: () => retryCount,
        setRetryCount: (n: number) => {
          retryCount = n;
        },
      });

      await createConnection(ctx);
      capturedOnData!("data");

      expect(retryCount).toBe(0);
    });

    it("should call notifyOnData when provided", async () => {
      let capturedOnData: ((d: string) => void) | undefined;
      const notifyOnData = vi.fn();

      const ctx = makeContext({
        subscriberFn: vi.fn((_key, callbacks) => {
          capturedOnData = callbacks.onData;
          return { unsubscribe: vi.fn() };
        }),
        notifyOnData,
      });

      await createConnection(ctx);
      capturedOnData!("hello");

      expect(notifyOnData).toHaveBeenCalledWith("hello");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // T008: Error -> retry flow
  // ═══════════════════════════════════════════════════════════════

  describe("error and retry flow", () => {
    it("should increment retry count on error", async () => {
      let capturedOnError: ((err: Error) => void) | undefined;
      let retryCount = 0;

      const ctx = makeContext({
        subscriberFn: vi.fn((_key, callbacks) => {
          capturedOnError = callbacks.onError;
          return { unsubscribe: vi.fn() };
        }),
        getRetryCount: () => retryCount,
        setRetryCount: (n: number) => {
          retryCount = n;
        },
      });

      await createConnection(ctx);
      capturedOnError!(new Error("connection lost"));

      expect(retryCount).toBe(1);
      expect(ctx.onError).toHaveBeenCalled();
    });

    it("should set status to connecting and schedule retry", async () => {
      let capturedOnError: ((err: Error) => void) | undefined;
      let retryCount = 0;
      let timerSet: ReturnType<typeof setTimeout> | null = null;

      const ctx = makeContext({
        subscriberFn: vi.fn((_key, callbacks) => {
          capturedOnError = callbacks.onError;
          return { unsubscribe: vi.fn() };
        }),
        getRetryCount: () => retryCount,
        setRetryCount: (n: number) => {
          retryCount = n;
        },
        setRetryTimer: (timer) => {
          timerSet = timer;
        },
      });

      await createConnection(ctx);
      capturedOnError!(new Error("fail"));

      expect(ctx.onStatusChange).toHaveBeenCalledWith("connecting");
      expect(timerSet).not.toBeNull();
    });

    it("should use exponential backoff for retry delay", async () => {
      let capturedOnError: ((err: Error) => void) | undefined;
      let retryCount = 0;
      const subscriberFn = vi.fn((_key: string, callbacks: { onError: (e: Error) => void }) => {
        capturedOnError = callbacks.onError;
        return { unsubscribe: vi.fn() };
      });

      const ctx = makeContext({
        subscriberFn,
        retryInterval: 1000,
        getRetryCount: () => retryCount,
        setRetryCount: (n: number) => {
          retryCount = n;
        },
      });

      await createConnection(ctx);

      // First error -> retryCount becomes 1, delay = 1000 * 2^0 = 1000ms
      capturedOnError!(new Error("fail"));
      expect(retryCount).toBe(1);

      // Advance 999ms -> should NOT retry yet
      await vi.advanceTimersByTimeAsync(999);
      expect(subscriberFn).toHaveBeenCalledTimes(1);

      // Advance 1 more ms -> should retry
      await vi.advanceTimersByTimeAsync(1);
      expect(subscriberFn).toHaveBeenCalledTimes(2);
    });

    it("should call notifyOnError and notifyOnStatusChange", async () => {
      let capturedOnError: ((err: Error) => void) | undefined;
      const notifyOnError = vi.fn();
      const notifyOnStatusChange = vi.fn();

      const ctx = makeContext({
        subscriberFn: vi.fn((_key, callbacks) => {
          capturedOnError = callbacks.onError;
          return { unsubscribe: vi.fn() };
        }),
        notifyOnError,
        notifyOnStatusChange,
      });

      await createConnection(ctx);
      capturedOnError!(new Error("fail"));

      expect(notifyOnError).toHaveBeenCalled();
      expect(notifyOnStatusChange).toHaveBeenCalledWith("connecting");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // T009: Max retries exceeded
  // ═══════════════════════════════════════════════════════════════

  describe("max retries exceeded", () => {
    it("should set status to disconnected when max retries exceeded", async () => {
      let capturedOnError: ((err: Error) => void) | undefined;
      let retryCount = 3; // already at max

      const ctx = makeContext({
        subscriberFn: vi.fn((_key, callbacks) => {
          capturedOnError = callbacks.onError;
          return { unsubscribe: vi.fn() };
        }),
        maxRetries: 3,
        getRetryCount: () => retryCount,
        setRetryCount: (n: number) => {
          retryCount = n;
        },
      });

      await createConnection(ctx);
      capturedOnError!(new Error("final error"));

      // retryCount becomes 4, > maxRetries(3), so disconnected
      expect(ctx.onStatusChange).toHaveBeenCalledWith("disconnected");
    });

    it("should notify disconnected status via callback", async () => {
      let capturedOnError: ((err: Error) => void) | undefined;
      let retryCount = 3;
      const notifyOnStatusChange = vi.fn();

      const ctx = makeContext({
        subscriberFn: vi.fn((_key, callbacks) => {
          capturedOnError = callbacks.onError;
          return { unsubscribe: vi.fn() };
        }),
        maxRetries: 3,
        getRetryCount: () => retryCount,
        setRetryCount: (n: number) => {
          retryCount = n;
        },
        notifyOnStatusChange,
      });

      await createConnection(ctx);
      capturedOnError!(new Error("final error"));

      expect(notifyOnStatusChange).toHaveBeenCalledWith("disconnected");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // T010: Cancelled connection
  // ═══════════════════════════════════════════════════════════════

  describe("cancelled connection", () => {
    it("should do nothing when already cancelled", async () => {
      const ctx = makeContext({
        getCancelled: () => true,
      });

      await createConnection(ctx);

      expect(ctx.subscriberFn).not.toHaveBeenCalled();
      expect(ctx.onStatusChange).not.toHaveBeenCalled();
    });

    it("should ignore onData when cancelled during subscription", async () => {
      let capturedOnData: ((d: string) => void) | undefined;
      let cancelled = false;

      const ctx = makeContext({
        subscriberFn: vi.fn((_key, callbacks) => {
          capturedOnData = callbacks.onData;
          return { unsubscribe: vi.fn() };
        }),
        getCancelled: () => cancelled,
      });

      await createConnection(ctx);
      cancelled = true;
      capturedOnData!("should be ignored");

      expect(ctx.onData).not.toHaveBeenCalled();
    });

    it("should ignore onError when cancelled during subscription", async () => {
      let capturedOnError: ((err: Error) => void) | undefined;
      let cancelled = false;

      const ctx = makeContext({
        subscriberFn: vi.fn((_key, callbacks) => {
          capturedOnError = callbacks.onError;
          return { unsubscribe: vi.fn() };
        }),
        getCancelled: () => cancelled,
      });

      await createConnection(ctx);
      cancelled = true;
      capturedOnError!(new Error("should be ignored"));

      expect(ctx.onError).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // T011: Async subscriber results
  // ═══════════════════════════════════════════════════════════════

  describe("async subscriber results", () => {
    it("should handle async subscriber that returns Promise", async () => {
      const unsubscribe = vi.fn();
      let setUnsubFnValue: (() => void) | null = null;

      const ctx = makeContext({
        subscriberFn: vi.fn(() => Promise.resolve({ unsubscribe })),
        setUnsubFn: (fn) => {
          setUnsubFnValue = fn;
        },
      });

      await createConnection(ctx);
      expect(setUnsubFnValue).toBe(unsubscribe);
    });

    it("should immediately unsubscribe if cancelled during async resolve", async () => {
      const unsubscribe = vi.fn();
      let cancelled = false;

      const ctx = makeContext({
        subscriberFn: vi.fn(() => {
          cancelled = true; // Cancel during resolution
          return Promise.resolve({ unsubscribe });
        }),
        getCancelled: () => cancelled,
      });

      await createConnection(ctx);
      expect(unsubscribe).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // T011 continued: subscriberFn throws
  // ═══════════════════════════════════════════════════════════════

  describe("subscriberFn throws synchronously", () => {
    it("should catch error and schedule retry", async () => {
      let retryCount = 0;
      let timerSet: ReturnType<typeof setTimeout> | null = null;

      const ctx = makeContext({
        subscriberFn: vi.fn(() => {
          throw new Error("connection refused");
        }),
        getRetryCount: () => retryCount,
        setRetryCount: (n: number) => {
          retryCount = n;
        },
        setRetryTimer: (timer) => {
          timerSet = timer;
        },
      });

      await createConnection(ctx);

      expect(ctx.onError).toHaveBeenCalled();
      expect(retryCount).toBe(1);
      expect(timerSet).not.toBeNull();
    });

    it("should disconnect if throw exceeds max retries", async () => {
      let retryCount = 3;

      const ctx = makeContext({
        subscriberFn: vi.fn(() => {
          throw new Error("connection refused");
        }),
        maxRetries: 3,
        getRetryCount: () => retryCount,
        setRetryCount: (n: number) => {
          retryCount = n;
        },
      });

      await createConnection(ctx);

      expect(ctx.onStatusChange).toHaveBeenCalledWith("disconnected");
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// T012: handleResult tests
// ═══════════════════════════════════════════════════════════════

describe("handleResult", () => {
  it("should set unsubFn for sync result", () => {
    const unsubscribe = vi.fn();
    let storedFn: (() => void) | null = null;

    handleResult(
      { unsubscribe },
      () => false,
      (fn) => {
        storedFn = fn;
      },
    );

    expect(storedFn).toBe(unsubscribe);
  });

  it("should immediately unsubscribe sync result if cancelled", () => {
    const unsubscribe = vi.fn();

    handleResult({ unsubscribe }, () => true, vi.fn());

    expect(unsubscribe).toHaveBeenCalled();
  });

  it("should set unsubFn for async result", async () => {
    const unsubscribe = vi.fn();
    let storedFn: (() => void) | null = null;

    await handleResult(
      Promise.resolve({ unsubscribe }),
      () => false,
      (fn) => {
        storedFn = fn;
      },
    );

    expect(storedFn).toBe(unsubscribe);
  });

  it("should immediately unsubscribe async result if cancelled", async () => {
    const unsubscribe = vi.fn();

    await handleResult(Promise.resolve({ unsubscribe }), () => true, vi.fn());

    expect(unsubscribe).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// US6: subscriber onError receives SWRError
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// buildConnectionContext tests
// ═══════════════════════════════════════════════════════════════

describe("buildConnectionContext", () => {
  function makeState(): SubscriptionState<string> {
    return {
      data: undefined,
      error: undefined,
      status: "connecting" as SubscriptionStatus,
      isConnecting: true,
      isLive: false,
      isDisconnected: false,
    };
  }

  function makeRefs(): SubscriptionRefs {
    let retryCount = 0;
    let cancelled = false;
    let unsubFn: (() => void) | null = null;
    return {
      getCancelled: () => cancelled,
      getRetryCount: () => retryCount,
      setRetryCount: (n) => {
        retryCount = n;
      },
      setUnsubFn: (fn) => {
        unsubFn = fn;
      },
      getUnsubFn: () => unsubFn,
      setRetryTimer: vi.fn(),
    };
  }

  it("should return a ConnectionContext with all required fields", () => {
    const state = makeState();
    const refs = makeRefs();
    const subscriberFn = vi.fn(() => ({ unsubscribe: vi.fn() }));

    const ctx = buildConnectionContext<string, string>({
      key: "test-key",
      subscriberFn,
      maxRetries: 5,
      retryInterval: 2000,
      state,
      refs,
    });

    expect(ctx.key).toBe("test-key");
    expect(ctx.subscriberFn).toBe(subscriberFn);
    expect(ctx.maxRetries).toBe(5);
    expect(ctx.retryInterval).toBe(2000);
    expect(typeof ctx.onStatusChange).toBe("function");
    expect(typeof ctx.onData).toBe("function");
    expect(typeof ctx.onError).toBe("function");
    expect(typeof ctx.getCancelled).toBe("function");
    expect(typeof ctx.getRetryCount).toBe("function");
    expect(typeof ctx.setRetryCount).toBe("function");
  });

  it("onStatusChange should update state derived booleans", () => {
    const state = makeState();
    const ctx = buildConnectionContext<string, string>({
      key: "k",
      subscriberFn: vi.fn(() => ({ unsubscribe: vi.fn() })),
      maxRetries: 3,
      retryInterval: 1000,
      state,
      refs: makeRefs(),
    });

    ctx.onStatusChange("live");
    expect(state.status).toBe("live");
    expect(state.isLive).toBe(true);
    expect(state.isConnecting).toBe(false);
    expect(state.isDisconnected).toBe(false);

    ctx.onStatusChange("disconnected");
    expect(state.status).toBe("disconnected");
    expect(state.isDisconnected).toBe(true);
    expect(state.isLive).toBe(false);
  });

  it("onData should update state.data and clear state.error", () => {
    const state = makeState();
    state.error = { type: "network", message: "err", retryCount: 0, timestamp: 1 };
    const ctx = buildConnectionContext<string, string>({
      key: "k",
      subscriberFn: vi.fn(() => ({ unsubscribe: vi.fn() })),
      maxRetries: 3,
      retryInterval: 1000,
      state,
      refs: makeRefs(),
    });

    ctx.onData("hello");
    expect(state.data).toBe("hello");
    expect(state.error).toBeUndefined();
  });

  it("onError should update state.error", () => {
    const state = makeState();
    const swrError: SWRError = {
      type: "network",
      message: "fail",
      retryCount: 1,
      timestamp: Date.now(),
    };
    const ctx = buildConnectionContext<string, string>({
      key: "k",
      subscriberFn: vi.fn(() => ({ unsubscribe: vi.fn() })),
      maxRetries: 3,
      retryInterval: 1000,
      state,
      refs: makeRefs(),
    });

    ctx.onError(swrError);
    expect(state.error).toBe(swrError);
  });

  it("should wrap notify callbacks in try/catch (swallow errors)", () => {
    const state = makeState();
    const ctx = buildConnectionContext<string, string>({
      key: "k",
      subscriberFn: vi.fn(() => ({ unsubscribe: vi.fn() })),
      maxRetries: 3,
      retryInterval: 1000,
      state,
      refs: makeRefs(),
      callbacks: {
        onData: () => {
          throw new Error("callback crash");
        },
        onError: () => {
          throw new Error("callback crash");
        },
        onStatusChange: () => {
          throw new Error("callback crash");
        },
      },
    });

    // Should not throw
    expect(() => ctx.notifyOnData?.("data")).not.toThrow();
    expect(() =>
      ctx.notifyOnError?.({
        type: "network",
        message: "e",
        retryCount: 0,
        timestamp: 1,
      }),
    ).not.toThrow();
    expect(() => ctx.notifyOnStatusChange?.("live")).not.toThrow();
  });

  it("should leave notify callbacks undefined when no callbacks provided", () => {
    const state = makeState();
    const ctx = buildConnectionContext<string, string>({
      key: "k",
      subscriberFn: vi.fn(() => ({ unsubscribe: vi.fn() })),
      maxRetries: 3,
      retryInterval: 1000,
      state,
      refs: makeRefs(),
    });

    expect(ctx.notifyOnData).toBeUndefined();
    expect(ctx.notifyOnError).toBeUndefined();
    expect(ctx.notifyOnStatusChange).toBeUndefined();
  });
});

describe("US6: subscriber onError receives SWRError", () => {
  it("should convert raw Error to SWRError with type, message, retryCount, timestamp", async () => {
    vi.useFakeTimers();
    const ctx = makeContext({
      maxRetries: 0, // No retry, just test error conversion
      subscriberFn: vi.fn((_key, callbacks) => {
        // Simulate subscriber calling onError with a raw Error
        callbacks.onError(new Error("connection lost"));
        return { unsubscribe: vi.fn() };
      }),
    });

    await createConnection(ctx);

    expect(ctx.onError).toHaveBeenCalledOnce();
    const swrError = (ctx.onError as any).mock.calls[0][0];
    expect(swrError).toHaveProperty("type");
    expect(swrError).toHaveProperty("message", "connection lost");
    expect(swrError).toHaveProperty("retryCount");
    expect(swrError).toHaveProperty("timestamp");
    expect(swrError.timestamp).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("should pass through SWRError without double-wrapping", async () => {
    vi.useFakeTimers();
    const swrError = {
      type: "network" as const,
      message: "already SWRError",
      retryCount: 2,
      timestamp: Date.now(),
      original: new TypeError("Failed to fetch"),
    };

    const ctx = makeContext({
      maxRetries: 0,
      subscriberFn: vi.fn((_key, callbacks) => {
        // Subscriber passes an already-converted SWRError
        callbacks.onError(swrError);
        return { unsubscribe: vi.fn() };
      }),
    });

    await createConnection(ctx);

    expect(ctx.onError).toHaveBeenCalledOnce();
    const received = (ctx.onError as any).mock.calls[0][0];
    expect(received.type).toBe("network");
    expect(received.message).toBe("already SWRError");
    vi.useRealTimers();
  });
});
