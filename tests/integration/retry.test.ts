import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HashedKey, ResolvedSWROptions, SWRError } from "../../src/types/index.ts";
import { store } from "../../src/cache/store.ts";
import {
  makeObserver,
  makeOptions,
  flush,
  resetObserverIdCounter,
} from "../../tests/helpers/index.ts";

/**
 * Create a mock QRL-like object that wraps a function.
 * QRL has a .resolve() method that returns Promise<fn>.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- QRL mock: only resolve() is needed for tests
function makeMockQrl<F extends Function>(fn: F): any {
  return { resolve: () => Promise.resolve(fn) };
}

// ═══════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.useFakeTimers();
  store._reset();
  resetObserverIdCounter();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════
// Integration: Retry behavior
// ═══════════════════════════════════════════════════════════════

describe("Integration: Retry behavior", () => {
  const KEY = "s:/api/retry-integration" as HashedKey;

  function setupWithObserver(opts?: Partial<ResolvedSWROptions>) {
    const observer = makeObserver(KEY);
    const resolvedOpts = makeOptions(opts);
    store.attachObserver(KEY, observer, resolvedOpts);
    return { observer, opts: resolvedOpts };
  }

  // ─── Test 1: retries up to configured retry count ───

  it("retries up to configured retry count", async () => {
    setupWithObserver({ retry: 3, retryInterval: 1_000 });

    let callCount = 0;
    const fetcher = vi.fn(() => {
      callCount++;
      return Promise.reject(new Error(`fail-${callCount}`));
    });

    store.ensureFetch(KEY, "/api/retry-integration", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1); // initial call

    // Retry 1 after 1000ms (1000 * 2^0)
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Retry 2 after 2000ms (1000 * 2^1)
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Retry 3 after 4000ms (1000 * 2^2)
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetcher).toHaveBeenCalledTimes(4);

    // Let the last rejection settle
    await flush();

    // No more retries after exhausting retry count
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  // ─── Test 2: uses exponential backoff ───

  it("uses exponential backoff: retryInterval * 2^retryCount", async () => {
    setupWithObserver({ retry: 3, retryInterval: 1_000 });

    const callTimestamps: number[] = [];
    const fetcher = vi.fn(() => {
      callTimestamps.push(Date.now());
      return Promise.reject(new Error("fail"));
    });

    store.ensureFetch(KEY, "/api/retry-integration", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Advance 999ms - should NOT have retried yet
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Advance 1ms more (total 1000ms = 1000 * 2^0) -> first retry
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Advance 1999ms - should NOT have retried yet
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Advance 1ms more (total 2000ms = 1000 * 2^1) -> second retry
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Advance 3999ms - should NOT have retried yet
    await vi.advanceTimersByTimeAsync(3_999);
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Advance 1ms more (total 4000ms = 1000 * 2^2) -> third retry
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(4);

    await flush();
  });

  // ─── Test 3: stops retrying on abort ───

  it("stops retrying on abort", async () => {
    const { observer } = setupWithObserver({ retry: 3, retryInterval: 1_000 });

    const fetcher = vi.fn(() => Promise.reject(new Error("fail")));

    store.ensureFetch(KEY, "/api/retry-integration", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // First retry fires after 1000ms
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Abort by detaching all observers (triggers abort on inflight)
    store.detachObserver(KEY, observer);

    // Remaining retries should NOT fire
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(2); // stopped after first retry
  });

  // ─── Test 4: calls onError$ after all retries exhausted ───

  it("calls onError$ after all retries exhausted", async () => {
    const onErrorFn = vi.fn();
    const onErrorQrl = makeMockQrl(onErrorFn);

    const observer = makeObserver(KEY);
    const opts = makeOptions({
      retry: 2,
      retryInterval: 500,
      onError$: onErrorQrl,
    });
    store.attachObserver(KEY, observer, opts);

    const fetcher = vi.fn(() => Promise.reject(new Error("persistent-error")));

    store.ensureFetch(KEY, "/api/retry-integration", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Retry 1 after 500ms (500 * 2^0)
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Retry 2 after 1000ms (500 * 2^1)
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Let all promises settle (including QRL resolution)
    await flush();

    // onError$ should have been called with the error and the key
    expect(onErrorFn).toHaveBeenCalledTimes(1);
    expect(onErrorFn).toHaveBeenCalledWith(
      expect.objectContaining({ message: "persistent-error" }),
      "/api/retry-integration",
    );

    // Observer's onError should also have been called
    expect(observer.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "persistent-error", retryCount: 2 }),
    );
  });

  // ─── Test 5: calls onErrorGlobal$ after all retries exhausted ───

  it("calls onErrorGlobal$ after all retries exhausted", async () => {
    const onErrorGlobalFn = vi.fn();
    const onErrorGlobalQrl = makeMockQrl(onErrorGlobalFn);

    const observer = makeObserver(KEY);
    const opts = makeOptions({
      retry: 1,
      retryInterval: 200,
      onErrorGlobal$: onErrorGlobalQrl,
    });
    store.attachObserver(KEY, observer, opts);

    const fetcher = vi.fn(() => Promise.reject(new Error("global-error")));

    store.ensureFetch(KEY, "/api/retry-integration", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Retry 1 after 200ms (200 * 2^0)
    await vi.advanceTimersByTimeAsync(200);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Let all promises settle (including QRL resolution)
    await flush();

    // onErrorGlobal$ should have been called
    expect(onErrorGlobalFn).toHaveBeenCalledTimes(1);
    expect(onErrorGlobalFn).toHaveBeenCalledWith(
      expect.objectContaining({ message: "global-error" }),
      "/api/retry-integration",
    );

    // Observer's onError should also have been called
    expect(observer.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "global-error", retryCount: 1 }),
    );
  });

  // ─── Test 6: does not retry when retry=0 ───

  it("does not retry when retry=0", async () => {
    const { observer } = setupWithObserver({ retry: 0, retryInterval: 1_000 });

    const fetcher = vi.fn(() => Promise.reject(new Error("no-retry")));

    store.ensureFetch(KEY, "/api/retry-integration", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Let the initial rejection settle
    await flush();

    // Wait a long time - no retries should happen
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Error should be notified immediately with retryCount=0
    expect(observer.onError).toHaveBeenCalledTimes(1);
    expect(observer.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "no-retry", retryCount: 0 }),
    );

    // fetchStatus should go back to idle
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("idle");
  });

  // ─── Test 7: should abort retry fetch that exceeds timeout ───

  it("should abort retry fetch that exceeds timeout", async () => {
    setupWithObserver({ retry: 2, retryInterval: 500, timeout: 1_000 });

    let callCount = 0;
    let retryAborted = false;
    const fetcher = vi.fn(
      (ctx: { signal: AbortSignal }) =>
        new Promise<string>((resolve, reject) => {
          callCount++;
          if (callCount === 1) {
            // First call: fail immediately to trigger retry
            reject(new Error("initial-fail"));
          } else {
            // Retry call: hang forever (never resolves) unless aborted
            ctx.signal.addEventListener("abort", () => {
              retryAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            });
          }
        }),
    );

    store.ensureFetch(KEY, "/api/retry-integration", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // First call fails -> retry after 500ms (500 * 2^0)
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Retry fetch hangs. Timeout (1000ms) should abort it.
    // Without the fix, no timeout is set for retries, so the fetch hangs forever.
    await vi.advanceTimersByTimeAsync(1_000);

    // Let abort + error settle
    await flush();

    // The retry fetch should have been aborted by timeout
    expect(retryAborted).toBe(true);
  });

  // ─── Test 8: retries with custom retryInterval function ───

  it("retries with custom retryInterval function", async () => {
    // Custom function: retryCount * 500 (linear backoff)
    const customInterval = vi.fn((retryCount: number, _error: SWRError) => retryCount * 500);

    const { observer } = setupWithObserver({
      retry: 3,
      retryInterval: customInterval,
    });

    let callCount = 0;
    const fetcher = vi.fn(() => {
      callCount++;
      return Promise.reject(new Error(`fail-${callCount}`));
    });

    store.ensureFetch(KEY, "/api/retry-integration", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Retry 1: customInterval(0, error) = 0 * 500 = 0ms
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Retry 2: customInterval(1, error) = 1 * 500 = 500ms
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Retry 3: customInterval(2, error) = 2 * 500 = 1000ms
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(4);

    // Let final rejection settle
    await flush();

    // No more retries
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(4); // 1 initial + 3 retries

    // Custom interval function should have been called for each retry
    expect(customInterval).toHaveBeenCalledTimes(3);
    expect(customInterval).toHaveBeenNthCalledWith(1, 0, expect.any(Object));
    expect(customInterval).toHaveBeenNthCalledWith(2, 1, expect.any(Object));
    expect(customInterval).toHaveBeenNthCalledWith(3, 2, expect.any(Object));

    // Error should be reported after all retries
    expect(observer.onError).toHaveBeenCalledWith(expect.objectContaining({ retryCount: 3 }));
  });
});
