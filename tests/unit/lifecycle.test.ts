import { describe, it, expect } from "vitest";
import { deriveStatus, mapEagerness } from "../../src/hooks/helpers.ts";
import { createObserver } from "../../src/hooks/create-observer.ts";
import type { SWRState } from "../../src/hooks/create-observer.ts";
import type { HashedKey, ResolvedSWROptions, SWRError, CacheEntry } from "../../src/types/index.ts";

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/** Create a full SWRState bag with plain values. */
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

function makeResolvedOptions<Data = unknown>(
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

// ═══════════════════════════════════════════════════════════════
// deriveStatus
// ═══════════════════════════════════════════════════════════════

describe("deriveStatus", () => {
  it('should return "success" when hasData=true (highest priority)', () => {
    expect(deriveStatus(true, true, "fetching")).toBe("success");
    expect(deriveStatus(true, true, "idle")).toBe("success");
    expect(deriveStatus(true, false, "fetching")).toBe("success");
    expect(deriveStatus(true, false, "idle")).toBe("success");
  });

  it('should return "loading" when no data and fetchStatus="fetching"', () => {
    expect(deriveStatus(false, false, "fetching")).toBe("loading");
    expect(deriveStatus(false, true, "fetching")).toBe("loading");
  });

  it('should return "error" when no data, not fetching, and hasError=true', () => {
    expect(deriveStatus(false, true, "idle")).toBe("error");
    expect(deriveStatus(false, true, "paused")).toBe("error");
  });

  it('should return "idle" when no data, no error, not fetching', () => {
    expect(deriveStatus(false, false, "idle")).toBe("idle");
    expect(deriveStatus(false, false, "paused")).toBe("idle");
  });
});

// ═══════════════════════════════════════════════════════════════
// mapEagerness
// ═══════════════════════════════════════════════════════════════

describe("mapEagerness", () => {
  it('should map "visible" to "intersection-observer"', () => {
    expect(mapEagerness("visible")).toBe("intersection-observer");
  });

  it('should map "load" to "document-ready"', () => {
    expect(mapEagerness("load")).toBe("document-ready");
  });

  it('should map "idle" to "document-idle"', () => {
    expect(mapEagerness("idle")).toBe("document-idle");
  });
});

// ═══════════════════════════════════════════════════════════════
// createObserver
// ═══════════════════════════════════════════════════════════════

describe("createObserver", () => {
  const HASHED_KEY = "s:/api/test" as HashedKey;
  const RAW_KEY = "/api/test";

  describe("observer structure", () => {
    it("should return an Observer with required fields", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>();

      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      expect(observer.id).toBeDefined();
      expect(typeof observer.id).toBe("string");
      expect(observer.id.length).toBeGreaterThan(0);
      expect(observer.hashedKey).toBe(HASHED_KEY);
      expect(observer.lastRawKey).toBe(RAW_KEY);
      expect(typeof observer.onData).toBe("function");
      expect(typeof observer.onError).toBe("function");
      expect(typeof observer.onFetchStatusChange).toBe("function");
    });

    it("should set hasData=true when state.data already has a value", () => {
      const state = makeState<string>({ data: "existing" });
      const opts = makeResolvedOptions<string>();

      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      expect(observer.hasData).toBe(true);
    });

    it("should set hasData=false when state.data is undefined", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>();

      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      expect(observer.hasData).toBe(false);
    });

    it("should generate a unique id for each observer", () => {
      const state1 = makeState<string>();
      const state2 = makeState<string>();
      const opts = makeResolvedOptions<string>();

      const observer1 = createObserver<string>(HASHED_KEY, RAW_KEY, state1, opts);
      const observer2 = createObserver<string>(HASHED_KEY, RAW_KEY, state2, opts);

      expect(observer1.id).not.toBe(observer2.id);
    });
  });

  describe("onData callback", () => {
    it("should update data and clear error", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>();
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      const entry: CacheEntry<string> = { data: "hello", timestamp: Date.now() };
      observer.onData(entry);

      expect(state.data).toBe("hello");
      expect(state.error).toBeUndefined();
    });

    it("should set status to success and update boolean fields", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>();
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      const entry: CacheEntry<string> = { data: "hello", timestamp: Date.now() };
      observer.onData(entry);

      expect(state.status).toBe("success");
      expect(state.isSuccess).toBe(true);
      expect(state.isError).toBe(false);
      expect(state.isLoading).toBe(false);
    });

    it("should mark isStale=false when entry is fresh (within staleTime)", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>({ staleTime: 30_000 });
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      const entry: CacheEntry<string> = { data: "fresh", timestamp: Date.now() };
      observer.onData(entry);

      expect(state.isStale).toBe(false);
    });

    it("should mark isStale=true when entry is stale (older than staleTime)", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>({ staleTime: 30_000 });
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      const entry: CacheEntry<string> = {
        data: "stale",
        timestamp: Date.now() - 60_000,
      };
      observer.onData(entry);

      expect(state.isStale).toBe(true);
    });

    it("should mark isStale=true when staleTime=0 (always stale)", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>({ staleTime: 0 });
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      const entry: CacheEntry<string> = { data: "data", timestamp: Date.now() };
      observer.onData(entry);

      expect(state.isStale).toBe(true);
    });
  });

  describe("onError callback", () => {
    it("should set error", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>();
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      const swrError: SWRError = {
        type: "network",
        message: "Failed to fetch",
        retryCount: 0,
        timestamp: Date.now(),
      };
      observer.onError(swrError);

      expect(state.error).toBe(swrError);
    });

    it("should derive status as error when no data exists", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>();
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      const swrError: SWRError = {
        type: "network",
        message: "fail",
        retryCount: 0,
        timestamp: Date.now(),
      };
      observer.onError(swrError);

      expect(state.status).toBe("error");
      expect(state.isError).toBe(true);
      expect(state.isLoading).toBe(false);
    });

    it("should keep status as success when data already exists", () => {
      const state = makeState<string>({ data: "existing-data" });
      const opts = makeResolvedOptions<string>();
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      const swrError: SWRError = {
        type: "network",
        message: "revalidation failed",
        retryCount: 1,
        timestamp: Date.now(),
      };
      observer.onError(swrError);

      expect(state.status).toBe("success");
      expect(state.isError).toBe(true);
      expect(state.error).toBe(swrError);
    });
  });

  describe("onFetchStatusChange callback", () => {
    it("should update fetchStatus and isValidating when fetching", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>();
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      observer.onFetchStatusChange("fetching");

      expect(state.fetchStatus).toBe("fetching");
      expect(state.isValidating).toBe(true);
    });

    it("should update fetchStatus and clear isValidating when idle", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>();
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      observer.onFetchStatusChange("fetching");
      observer.onFetchStatusChange("idle");

      expect(state.fetchStatus).toBe("idle");
      expect(state.isValidating).toBe(false);
    });

    it("should derive status as loading when fetching with no data", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>();
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      observer.onFetchStatusChange("fetching");

      expect(state.status).toBe("loading");
      expect(state.isLoading).toBe(true);
    });

    it("should derive status as success when fetching with existing data", () => {
      const state = makeState<string>({ data: "existing" });
      const opts = makeResolvedOptions<string>();
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      observer.onFetchStatusChange("fetching");

      expect(state.status).toBe("success");
      expect(state.isLoading).toBe(false);
      expect(state.isValidating).toBe(true);
    });

    it("should derive status as idle when going idle with no data and no error", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>();
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      observer.onFetchStatusChange("idle");

      expect(state.status).toBe("idle");
      expect(state.isLoading).toBe(false);
    });

    it("should derive status as error when going idle with existing error and no data", () => {
      const state = makeState<string>();
      const opts = makeResolvedOptions<string>();
      const observer = createObserver<string>(HASHED_KEY, RAW_KEY, state, opts);

      // Simulate error already set
      state.error = {
        type: "network",
        message: "fail",
        retryCount: 0,
        timestamp: Date.now(),
      };

      observer.onFetchStatusChange("idle");

      expect(state.status).toBe("error");
      expect(state.isLoading).toBe(false);
    });
  });
});
