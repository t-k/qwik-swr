import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResolvedQueryConfig } from "../../src/types/index.ts";
import { store } from "../../src/cache/store.ts";
import { hashKey } from "../../src/utils/hash.ts";
import { startFetchLifecycle, type ActiveLifecycle } from "../../src/hooks/lifecycle-state.ts";
import { createObserver } from "../../src/hooks/create-observer.ts";
import type { SWRState } from "../../src/hooks/create-observer.ts";
import { isDisabledKey } from "../../src/utils/resolve-key.ts";
import {
  makeOptions as makeOptionsBase,
  makeFetcher,
  flush,
  resetObserverIdCounter,
} from "../helpers/index.ts";

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function makeOptions(overrides: Partial<ResolvedQueryConfig> = {}): ResolvedQueryConfig {
  return makeOptionsBase({
    staleTime: 0,
    retry: 0,
    revalidateOn: [],
    keepPreviousData: false,
    ...overrides,
  });
}

function makeState<Data>(overrides: Partial<SWRState<Data>> = {}): SWRState<Data> {
  return {
    data: undefined as Data | undefined,
    error: undefined,
    status: "idle",
    fetchStatus: "idle",
    isLoading: false,
    isSuccess: false,
    isError: false,
    isValidating: false,
    isStale: false,
    ...overrides,
  };
}

/**
 * Simulate a key transition (what useVisibleTask$ does when Signal changes).
 * Tears down previous lifecycle, starts new one.
 */
function transitionKey<Data>(
  currentLifecycle: ActiveLifecycle<Data> | null,
  newKey: string | null | undefined | false,
  fetcherFn: (ctx: any) => Data | Promise<Data>,
  state: SWRState<Data>,
  opts: ResolvedQueryConfig<Data>,
): ActiveLifecycle<Data> | null {
  // Teardown previous
  currentLifecycle?.teardown();

  if (isDisabledKey(newKey)) {
    // Reset state
    if (!opts.keepPreviousData) {
      state.data = undefined;
      state.error = undefined;
      state.status = "idle";
      state.fetchStatus = "idle";
      state.isLoading = false;
      state.isSuccess = false;
      state.isError = false;
      state.isValidating = false;
      state.isStale = false;
    } else {
      // keepPreviousData: disabled transition still resets
      state.data = undefined;
      state.error = undefined;
      state.status = "idle";
      state.fetchStatus = "idle";
      state.isLoading = false;
      state.isSuccess = false;
      state.isError = false;
      state.isValidating = false;
      state.isStale = false;
    }
    return null;
  }

  const hashed = hashKey(newKey);

  // If not keepPreviousData, reset state
  if (!opts.keepPreviousData) {
    state.data = undefined;
    state.error = undefined;
    state.status = "idle";
    state.fetchStatus = "idle";
    state.isLoading = false;
    state.isSuccess = false;
    state.isError = false;
    state.isValidating = false;
    state.isStale = false;
  }

  const observer = createObserver<Data>(hashed, newKey, state, opts as any);

  return startFetchLifecycle({
    hashedKey: hashed,
    rawKey: newKey,
    fetcherFn,
    observer,
    resolved: opts,
  });
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
// Signal key transition scenarios
// ═══════════════════════════════════════════════════════════════

describe("Signal key transitions (store + observer level)", () => {
  describe("disabled -> valid key transition", () => {
    it("should start fetching when key becomes valid", async () => {
      const opts = makeOptions();
      const state = makeState<string>();
      const fetcher = makeFetcher("user-data");

      // Start with disabled key
      let lifecycle = transitionKey<string>(null, null, fetcher, state, opts);
      expect(lifecycle).toBeNull();
      expect(state.status).toBe("idle");
      expect(fetcher).not.toHaveBeenCalled();

      // Transition to valid key
      lifecycle = transitionKey<string>(lifecycle, "/api/users", fetcher, state, opts);
      expect(lifecycle).not.toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);

      await flush();

      expect(state.data).toBe("user-data");
      expect(state.status).toBe("success");
    });
  });

  describe("valid -> disabled key transition", () => {
    it("should teardown and reset state", async () => {
      const opts = makeOptions();
      const state = makeState<string>();
      const fetcher = makeFetcher("user-data");

      // Start with valid key
      let lifecycle = transitionKey<string>(null, "/api/users", fetcher, state, opts);
      await flush();

      expect(state.data).toBe("user-data");
      expect(state.status).toBe("success");

      // Transition to disabled
      lifecycle = transitionKey<string>(lifecycle, null, fetcher, state, opts);
      expect(lifecycle).toBeNull();
      expect(state.data).toBeUndefined();
      expect(state.status).toBe("idle");
    });
  });

  describe("valid A -> valid B key transition", () => {
    it("should teardown A observer and start fetch for B", async () => {
      const opts = makeOptions();
      const state = makeState<string>();

      const fetcher = vi.fn(async (ctx: any) => {
        if (ctx.rawKey === "/api/a") return "data-A";
        return "data-B";
      });

      // Start with key A
      let lifecycle = transitionKey<string>(null, "/api/a", fetcher, state, opts);
      await flush();

      expect(state.data).toBe("data-A");
      expect(state.status).toBe("success");

      // Transition to key B
      lifecycle = transitionKey<string>(lifecycle, "/api/b", fetcher, state, opts);

      // State was reset (no keepPreviousData), then fetch started immediately
      // so status transitions from idle -> loading synchronously
      expect(state.status).toBe("loading");

      await flush();

      expect(state.data).toBe("data-B");
      expect(state.status).toBe("success");
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("should detach A observer so A setCache does not affect B state", async () => {
      const opts = makeOptions();
      const state = makeState<string>();
      const fetcher = makeFetcher("initial");

      // Start with key A
      let lifecycle = transitionKey<string>(null, "/api/a", fetcher, state, opts);
      await flush();

      const hashedA = hashKey("/api/a");

      // Transition to key B
      lifecycle = transitionKey<string>(lifecycle, "/api/b", fetcher, state, opts);
      await flush();

      // Now write to key A cache - should NOT affect state (observer detached)
      state.data = "data-B-final";
      store.setCache(hashedA, { data: "stale-A-update", timestamp: Date.now() });

      expect(state.data).toBe("data-B-final");
    });
  });

  describe("inflight fetch abort on key change", () => {
    it("should abort inflight fetch when key changes", async () => {
      const opts = makeOptions();
      const state = makeState<string>();

      // Slow fetcher that takes 1000ms
      const slowFetcher = vi.fn(
        (_ctx: any) =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve("slow-data"), 1000);
          }),
      );

      // Start with key A (slow fetch)
      let lifecycle = transitionKey<string>(null, "/api/slow", slowFetcher, state, opts);

      expect(slowFetcher).toHaveBeenCalledTimes(1);

      // Before fetch completes, transition to key B
      const fastFetcher = makeFetcher("fast-data");
      lifecycle = transitionKey<string>(lifecycle, "/api/fast", fastFetcher, state, opts);

      await flush();

      // Fast fetcher should have been called
      expect(fastFetcher).toHaveBeenCalledTimes(1);
      expect(state.data).toBe("fast-data");

      // Complete the slow fetch timer - should not affect state
      await vi.advanceTimersByTimeAsync(1000);
      await flush();

      // State should still be fast-data
      expect(state.data).toBe("fast-data");
    });
  });

  describe("MutationContext keyRef", () => {
    it("should always reference the latest key", async () => {
      const keyRef: { current: string | null } = { current: null };

      // Simulate key transitions
      keyRef.current = null;
      expect(isDisabledKey(keyRef.current)).toBe(true);

      keyRef.current = "/api/users/1";
      expect(isDisabledKey(keyRef.current)).toBe(false);
      expect(hashKey(keyRef.current)).toBe("s:/api/users/1");

      keyRef.current = "/api/users/2";
      expect(isDisabledKey(keyRef.current)).toBe(false);
      expect(hashKey(keyRef.current)).toBe("s:/api/users/2");

      keyRef.current = null;
      expect(isDisabledKey(keyRef.current)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// keepPreviousData
// ═══════════════════════════════════════════════════════════════

describe("keepPreviousData", () => {
  it("should retain previous data during key transition when enabled", async () => {
    const opts = makeOptions({ keepPreviousData: true });
    const state = makeState<string>();

    const fetcher = vi.fn(async (ctx: any) => {
      if (ctx.rawKey === "/api/a") return "data-A";
      return "data-B";
    });

    // Start with key A
    let lifecycle = transitionKey<string>(null, "/api/a", fetcher, state, opts);
    await flush();

    expect(state.data).toBe("data-A");
    expect(state.status).toBe("success");

    // Transition to key B - data should be retained
    lifecycle = transitionKey<string>(lifecycle, "/api/b", fetcher, state, opts);

    // Before B resolves, state should still have A's data
    expect(state.data).toBe("data-A");
    expect(state.status).toBe("success");

    await flush();

    // After B resolves, data should be updated
    expect(state.data).toBe("data-B");
    expect(state.status).toBe("success");
  });

  it("should reset data on disabled transition even with keepPreviousData", async () => {
    const opts = makeOptions({ keepPreviousData: true });
    const state = makeState<string>();

    const fetcher = makeFetcher("data-A");

    // Start with valid key
    let lifecycle = transitionKey<string>(null, "/api/a", fetcher, state, opts);
    await flush();

    expect(state.data).toBe("data-A");

    // Transition to disabled - should reset despite keepPreviousData
    lifecycle = transitionKey<string>(lifecycle, null, fetcher, state, opts);

    expect(state.data).toBeUndefined();
    expect(state.status).toBe("idle");
  });

  it("should not retain data when keepPreviousData is false", async () => {
    const opts = makeOptions({ keepPreviousData: false });
    const state = makeState<string>();

    const fetcher = vi.fn(async (ctx: any) => {
      return new Promise<string>((resolve) => {
        setTimeout(() => resolve(ctx.rawKey === "/api/a" ? "data-A" : "data-B"), 100);
      });
    });

    // Start with key A
    let lifecycle = transitionKey<string>(null, "/api/a", fetcher, state, opts);
    await vi.advanceTimersByTimeAsync(100);
    await flush();

    expect(state.data).toBe("data-A");

    // Transition to key B - state should be reset immediately
    lifecycle = transitionKey<string>(lifecycle, "/api/b", fetcher, state, opts);

    expect(state.data).toBeUndefined();
    // Fetch started immediately, so status is loading (not idle)
    expect(state.status).toBe("loading");

    await vi.advanceTimersByTimeAsync(100);
    await flush();

    expect(state.data).toBe("data-B");
  });
});
