import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HashedKey, ResolvedSWROptions } from "../../src/types/index.ts";
import { store } from "../../src/cache/store.ts";
import {
  makeObserver,
  makeOptions,
  makeFetcher,
  flush,
  resetObserverIdCounter,
} from "../helpers/index.ts";

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
// Offline / Paused FetchStatus behavior
// ═══════════════════════════════════════════════════════════════

describe("Offline / Paused FetchStatus behavior", () => {
  const KEY = "s:/api/offline" as HashedKey;

  function setupWithObserver(opts?: Partial<ResolvedSWROptions>) {
    const observer = makeObserver(KEY);
    const resolvedOpts = makeOptions(opts);
    store.attachObserver(KEY, observer, resolvedOpts);
    return { observer, opts: resolvedOpts };
  }

  it("ensureFetch defers to pendingKeys when offline", () => {
    const { observer } = setupWithObserver();

    store.setOnline(false);

    const fetcher = makeFetcher("data");
    store.ensureFetch(KEY, "/api/offline", fetcher);

    // Fetcher should NOT have been called
    expect(fetcher).not.toHaveBeenCalled();

    // Observer should receive "paused" fetchStatus
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("paused");
  });

  it("setOnline(false) broadcasts 'paused' for inflight keys", async () => {
    const { observer } = setupWithObserver();

    // Start a fetch (creates inflight)
    const fetcher = makeFetcher("data", 5000);
    store.ensureFetch(KEY, "/api/offline", fetcher);

    // Verify fetching was broadcast
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("fetching");
    vi.mocked(observer.onFetchStatusChange).mockClear();

    // Go offline
    store.setOnline(false);

    // Should broadcast "paused" for the inflight key
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("paused");
  });

  it("setOnline(true) resumes pending keys", async () => {
    const { observer } = setupWithObserver({ staleTime: 0, dedupingInterval: 0 });

    // First, do a successful fetch while online so the fetcher gets stored in fetcherMap
    const fetcher = makeFetcher("initial-data");
    store.ensureFetch(KEY, "/api/offline", fetcher);
    await flush();

    // Verify initial fetch completed
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(observer.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "initial-data" }));

    // Go offline
    store.setOnline(false);

    // Try to fetch while offline - this defers to pendingKeys
    const fetcher2 = makeFetcher("offline-attempt");
    store.ensureFetch(KEY, "/api/offline", fetcher2);
    expect(fetcher2).not.toHaveBeenCalled();
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("paused");

    vi.mocked(observer.onFetchStatusChange).mockClear();

    // Go back online - should resume the pending key using fetcherMap
    store.setOnline(true);
    await flush();

    // BUG1 fix: offline ensureFetch now saves fetcher2 to fetcherMap,
    // so setOnline uses the latest fetcher (fetcher2) to resume.
    expect(fetcher2).toHaveBeenCalledTimes(1);
    expect(observer.onData).toHaveBeenCalledWith(
      expect.objectContaining({ data: "offline-attempt" }),
    );
  });

  it("setOnline(true) broadcasts 'fetching' for inflight keys", async () => {
    const { observer } = setupWithObserver();

    // Start a slow fetch
    const fetcher = makeFetcher("data", 10_000);
    store.ensureFetch(KEY, "/api/offline", fetcher);
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("fetching");

    // Go offline - broadcasts "paused"
    store.setOnline(false);
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("paused");
    vi.mocked(observer.onFetchStatusChange).mockClear();

    // Go online - should broadcast "fetching" for the existing inflight
    store.setOnline(true);
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("fetching");
  });

  it("pendingKeys are cleared after online resume", async () => {
    const { observer } = setupWithObserver({ staleTime: 0, dedupingInterval: 0 });

    // Do an initial fetch to store fetcher in fetcherMap
    const fetcher = makeFetcher("data");
    store.ensureFetch(KEY, "/api/offline", fetcher);
    await flush();

    // Go offline and attempt fetch (adds to pendingKeys)
    store.setOnline(false);
    const fetcher2 = makeFetcher("pending");
    store.ensureFetch(KEY, "/api/offline", fetcher2);

    // Go online - resumes and clears pendingKeys
    store.setOnline(true);
    await flush();

    // Going offline again and then online should NOT trigger another resume
    // (because pendingKeys was cleared)
    vi.mocked(observer.onFetchStatusChange).mockClear();
    vi.mocked(fetcher).mockClear();

    store.setOnline(false);
    store.setOnline(true);
    await flush();

    // The fetcher should NOT have been called again from resume
    // (no pending keys to resume)
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("store.isOnline getter reflects current state", () => {
    // Default: online (after _reset sets _isOnline=true)
    expect(store.isOnline).toBe(true);

    store.setOnline(false);
    expect(store.isOnline).toBe(false);

    store.setOnline(true);
    expect(store.isOnline).toBe(true);
  });

  it("new fetches work normally when online", async () => {
    const { observer } = setupWithObserver();

    // Store is online by default after _reset
    expect(store.isOnline).toBe(true);

    const fetcher = makeFetcher("online-data");
    store.ensureFetch(KEY, "/api/offline", fetcher);
    await flush();

    // Fetcher should have been called normally
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Observer should have received "fetching" then "idle"
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("fetching");
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("idle");

    // Data should be cached
    expect(observer.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "online-data" }));

    // Observer should NOT have received "paused"
    const calls = vi.mocked(observer.onFetchStatusChange).mock.calls;
    const hasPaused = calls.some((call) => call[0] === "paused");
    expect(hasPaused).toBe(false);
  });

  it("_reset restores online state", () => {
    store.setOnline(false);
    expect(store.isOnline).toBe(false);

    store._reset();
    expect(store.isOnline).toBe(true);
  });

  it("setOnline(true) resumes pending keys even when first fetch was offline (fetcherMap saved during offline ensureFetch)", async () => {
    const { observer } = setupWithObserver({ staleTime: 0, dedupingInterval: 0 });

    // Go offline BEFORE any fetch has ever been made for this key.
    // There is no prior fetcherMap entry at this point.
    store.setOnline(false);

    // Attempt to fetch while offline.
    // The BUG1 fix ensures ensureFetch saves the fetcher to fetcherMap
    // even when it defers due to offline status.
    const fetcher = makeFetcher("first-data");
    store.ensureFetch(KEY, "/api/offline", fetcher);

    // Fetcher should NOT have been called (we are offline)
    expect(fetcher).not.toHaveBeenCalled();

    // Observer should receive "paused"
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("paused");

    vi.mocked(observer.onFetchStatusChange).mockClear();

    // Go back online.
    // setOnline(true) iterates pendingKeys and calls ensureFetch
    // using the fetcher from fetcherMap. Because the BUG1 fix saved
    // the fetcher during the offline ensureFetch, the key IS resumed.
    store.setOnline(true);
    await flush();

    // The fetcher should have been called once when resuming
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Observer should have received "fetching" and then data
    expect(observer.onFetchStatusChange).toHaveBeenCalledWith("fetching");
    expect(observer.onData).toHaveBeenCalledWith(expect.objectContaining({ data: "first-data" }));
  });
});
