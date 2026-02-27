import { describe, it, expect, vi, afterEach } from "vitest";
import type { CacheEntry, HashedKey, ResolvedSWROptions, SWRError } from "../../src/types/index.ts";
import { createObserver, type SWRState } from "../../src/hooks/create-observer.ts";

// ===============================================================
// Helpers
// ===============================================================

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

function makeOptions<Data = unknown>(
  overrides: Partial<ResolvedSWROptions<Data>> = {},
): ResolvedSWROptions<Data> {
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
  } as ResolvedSWROptions<Data>;
}

function makeSWRError(overrides: Partial<SWRError> = {}): SWRError {
  return {
    type: "unknown",
    message: "test error",
    retryCount: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ===============================================================
// Tests
// ===============================================================

describe("createObserver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates observer with correct id and hashedKey", () => {
    const state = makeState<string>();
    const opts = makeOptions<string>();
    const observer = createObserver("s:/api/users" as HashedKey, "/api/users", state, opts);

    // generateId("obs") produces "obs-{uuid}" when crypto.randomUUID is available
    expect(observer.id).toMatch(
      /^obs-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(observer.hashedKey).toBe("s:/api/users");
  });

  it("should generate ID with fallback when crypto.randomUUID is unavailable (SF-5)", () => {
    const originalRandomUUID = crypto.randomUUID;
    // Temporarily remove randomUUID
    (crypto as any).randomUUID = undefined;

    try {
      const state = makeState<string>();
      const opts = makeOptions<string>();
      const observer = createObserver("s:/api/users" as HashedKey, "/api/users", state, opts);

      // Fallback: crypto.getRandomValues() produces obs-{32 hex chars}
      // or Date.now()+Math.random() produces obs-{timestamp}-{random}
      expect(observer.id).toMatch(/^obs-/);
      expect(observer.hashedKey).toBe("s:/api/users");
    } finally {
      crypto.randomUUID = originalRandomUUID;
    }
  });

  // ─────────────────────────────────────────────────────────────
  // onData
  // ─────────────────────────────────────────────────────────────

  it("onData updates all state correctly", () => {
    const state = makeState<string>();
    const opts = makeOptions<string>({ staleTime: 60_000 });
    const observer = createObserver("s:/api/users" as HashedKey, "/api/users", state, opts);

    const entry: CacheEntry<string> = {
      data: "hello",
      timestamp: Date.now(),
    };
    observer.onData(entry);

    expect(state.data).toBe("hello");
    expect(state.error).toBeUndefined();
    expect(state.status).toBe("success");
    expect(state.isSuccess).toBe(true);
    expect(state.isError).toBe(false);
    expect(state.isLoading).toBe(false);
    expect(state.isStale).toBe(false);
  });

  it("onData sets isStale=true when age > staleTime", () => {
    const state = makeState<string>();
    const opts = makeOptions<string>({ staleTime: 10_000 });
    const observer = createObserver("s:/api/users" as HashedKey, "/api/users", state, opts);

    const entry: CacheEntry<string> = {
      data: "old data",
      timestamp: Date.now() - 20_000,
    };
    observer.onData(entry);

    expect(state.isStale).toBe(true);
  });

  it("onData sets isStale=false when age < staleTime", () => {
    const state = makeState<string>();
    const opts = makeOptions<string>({ staleTime: 60_000 });
    const observer = createObserver("s:/api/users" as HashedKey, "/api/users", state, opts);

    const entry: CacheEntry<string> = {
      data: "fresh data",
      timestamp: Date.now() - 1_000,
    };
    observer.onData(entry);

    expect(state.isStale).toBe(false);
  });

  it("onData sets isStale=true when staleTime=0", () => {
    const state = makeState<string>();
    const opts = makeOptions<string>({ staleTime: 0 });
    const observer = createObserver("s:/api/users" as HashedKey, "/api/users", state, opts);

    const entry: CacheEntry<string> = {
      data: "always stale",
      timestamp: Date.now(),
    };
    observer.onData(entry);

    expect(state.isStale).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────
  // onError
  // ─────────────────────────────────────────────────────────────

  it("onError updates state correctly", () => {
    const state = makeState<string>();
    const opts = makeOptions<string>();
    const observer = createObserver("s:/api/users" as HashedKey, "/api/users", state, opts);

    const swrError = makeSWRError({ type: "network", message: "Failed to fetch" });
    observer.onError(swrError);

    expect(state.error).toBe(swrError);
    expect(state.isLoading).toBe(false);
  });

  it("onError with existing data: status=success, isError=true", () => {
    const state = makeState<string>({ data: "existing-data" });
    const opts = makeOptions<string>();
    const observer = createObserver("s:/api/users" as HashedKey, "/api/users", state, opts);

    const swrError = makeSWRError({ message: "revalidation failed" });
    observer.onError(swrError);

    expect(state.status).toBe("success");
    expect(state.isError).toBe(true);
    expect(state.error).toBe(swrError);
  });

  it("onError without existing data: status=error, isError=true", () => {
    const state = makeState<string>();
    const opts = makeOptions<string>();
    const observer = createObserver("s:/api/users" as HashedKey, "/api/users", state, opts);

    const swrError = makeSWRError({ message: "initial fetch failed" });
    observer.onError(swrError);

    expect(state.status).toBe("error");
    expect(state.isError).toBe(true);
    expect(state.error).toBe(swrError);
  });

  // ─────────────────────────────────────────────────────────────
  // onFetchStatusChange
  // ─────────────────────────────────────────────────────────────

  it("onFetchStatusChange updates fetchStatus and isValidating", () => {
    const state = makeState<string>();
    const opts = makeOptions<string>();
    const observer = createObserver("s:/api/users" as HashedKey, "/api/users", state, opts);

    observer.onFetchStatusChange("fetching");
    expect(state.fetchStatus).toBe("fetching");
    expect(state.isValidating).toBe(true);

    observer.onFetchStatusChange("idle");
    expect(state.fetchStatus).toBe("idle");
    expect(state.isValidating).toBe(false);
  });

  it("onFetchStatusChange updates isLoading when status becomes loading", () => {
    const state = makeState<string>();
    const opts = makeOptions<string>();
    const observer = createObserver("s:/api/users" as HashedKey, "/api/users", state, opts);

    observer.onFetchStatusChange("fetching");

    expect(state.status).toBe("loading");
    expect(state.isLoading).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────
  // fallbackData / SSR simulation
  // ─────────────────────────────────────────────────────────────

  it("initial state with fallbackData simulates SSR hydration", () => {
    const fallbackData = { id: 1, name: "Alice" };

    const state = makeState<typeof fallbackData>({
      data: fallbackData,
      status: "success",
      isSuccess: true,
    });
    const opts = makeOptions<typeof fallbackData>({ fallbackData });

    const observer = createObserver("s:/api/users/1" as HashedKey, "/api/users/1", state, opts);

    expect(observer.hasData).toBe(true);
    expect(state.data).toEqual(fallbackData);
    expect(state.status).toBe("success");
  });
});
