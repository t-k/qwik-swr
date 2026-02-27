import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HashedKey, ResolvedSWROptions, FetcherCtx } from "../../src/types/index.ts";
import type { Observer } from "../../src/cache/types.ts";
import { store } from "../../src/cache/store.ts";

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

let observerIdCounter = 0;

function makeObserver<Data = unknown>(
  hashedKey: HashedKey,
  overrides: Partial<Observer<Data>> = {},
): Observer<Data> {
  return {
    id: `leak-obs-${++observerIdCounter}`,
    hashedKey,
    lastRawKey: hashedKey,
    hasData: false,
    onData: vi.fn(),
    onError: vi.fn(),
    onFetchStatusChange: vi.fn(),
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ResolvedSWROptions> = {}): ResolvedSWROptions {
  return {
    enabled: true,
    eagerness: "visible",
    staleTime: 30_000,
    cacheTime: 300_000,
    revalidateOn: ["focus", "reconnect"],
    refreshInterval: 0,
    dedupingInterval: 2_000,
    retry: 3,
    retryInterval: 1_000,
    timeout: 30_000,
    ...overrides,
  } as ResolvedSWROptions;
}

// ═══════════════════════════════════════════════════════════════
// T019: deleteCache cleans up queryConfigMap
// ═══════════════════════════════════════════════════════════════

describe("queryConfigMap cleanup on deleteCache (US3)", () => {
  beforeEach(() => {
    store._reset();
    observerIdCounter = 0;
  });

  it("should remove queryConfigMap entry when deleteCache is called", () => {
    const key: HashedKey = "leak-delete-1" as HashedKey;
    const observer = makeObserver(key);
    const opts = makeOptions();

    store.attachObserver(key, observer, opts);
    expect(store._getQueryConfigMapSize()).toBe(1);

    store.deleteCache(key);
    expect(store._getQueryConfigMapSize()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// T020: detachObserver cleans up queryConfigMap when last observer leaves
// ═══════════════════════════════════════════════════════════════

describe("queryConfigMap cleanup on observer detach (US3)", () => {
  beforeEach(() => {
    store._reset();
    observerIdCounter = 0;
  });

  it("should keep queryConfigMap entry after all observers detach (GC needs cacheTime)", () => {
    const key: HashedKey = "leak-detach-1" as HashedKey;
    const observer1 = makeObserver(key);
    const observer2 = makeObserver(key);
    const opts = makeOptions();

    store.attachObserver(key, observer1, opts);
    store.attachObserver(key, observer2, opts);
    expect(store._getQueryConfigMapSize()).toBe(1);

    // Detach first observer - config should remain
    store.detachObserver(key, observer1);
    expect(store._getQueryConfigMapSize()).toBe(1);

    // Detach second (last) observer - config still remains (GC needs it for orphaned entries)
    store.detachObserver(key, observer2);
    expect(store._getQueryConfigMapSize()).toBe(1);

    // deleteCache cleans it up
    store.deleteCache(key);
    expect(store._getQueryConfigMapSize()).toBe(0);
  });

  it("should keep queryConfigMap entry when observers detach but cache entry exists (for GC)", () => {
    const key: HashedKey = "leak-detach-2" as HashedKey;
    const observer = makeObserver(key);
    const opts = makeOptions();

    store.attachObserver(key, observer, opts);
    store.setCache(key, { data: "some-data", timestamp: Date.now() });

    // Detach observer - config should remain because GC needs cacheTime
    store.detachObserver(key, observer);
    expect(store._getQueryConfigMapSize()).toBe(1);

    // deleteCache should clean it up
    store.deleteCache(key);
    expect(store._getQueryConfigMapSize()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// T021: 1000x add/delete cycle keeps queryConfigMap bounded (SC-003)
// ═══════════════════════════════════════════════════════════════

describe("queryConfigMap bounded after 1000 add/delete cycles (US3, SC-003)", () => {
  beforeEach(() => {
    store._reset();
    observerIdCounter = 0;
  });

  it("should have queryConfigMap size 0 after 1000 add/delete cycles", () => {
    const opts = makeOptions();

    for (let i = 0; i < 1000; i++) {
      const key = `leak-cycle-${i}` as HashedKey;
      const observer = makeObserver(key);
      store.attachObserver(key, observer, opts);
      store.setCache(key, { data: `data-${i}`, timestamp: Date.now() });
      store.deleteCache(key);
      store.detachObserver(key, observer);
    }

    expect(store._getQueryConfigMapSize()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// T022: _reset() cancels all cooldown timers (SC-004)
// ═══════════════════════════════════════════════════════════════

describe("_reset() cancels cooldown timers (US3, SC-004)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store._reset();
    observerIdCounter = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should have no active timers after _reset()", async () => {
    const key: HashedKey = "leak-timer-1" as HashedKey;
    const observer = makeObserver(key);
    const opts = makeOptions({ dedupingInterval: 5_000 });
    store.attachObserver(key, observer, opts);

    const fetcher = vi.fn((_ctx: FetcherCtx) => Promise.resolve("data"));
    store.ensureFetch(key, key, fetcher);
    await vi.advanceTimersByTimeAsync(0); // Let fetch complete

    // Cooldown should be active
    expect(store._getCooldownMapSize()).toBe(1);

    // Track that clearTimeout was called
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    store._reset();

    // clearTimeout should have been called for the cooldown timer
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(store._getCooldownMapSize()).toBe(0);

    clearTimeoutSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════
// T023: clearCache() cancels cooldown timers
// ═══════════════════════════════════════════════════════════════

describe("clearCache() cancels cooldown timers (US3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store._reset();
    observerIdCounter = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should cancel all cooldown timers on clearCache()", async () => {
    const key: HashedKey = "leak-clear-1" as HashedKey;
    const observer = makeObserver(key);
    const opts = makeOptions({ dedupingInterval: 5_000 });
    store.attachObserver(key, observer, opts);

    const fetcher = vi.fn((_ctx: FetcherCtx) => Promise.resolve("data"));
    store.ensureFetch(key, key, fetcher);
    await vi.advanceTimersByTimeAsync(0);

    expect(store._getCooldownMapSize()).toBe(1);

    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    store.clearCache();

    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(store._getCooldownMapSize()).toBe(0);

    clearTimeoutSpy.mockRestore();
  });
});
