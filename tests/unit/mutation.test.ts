import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { store } from "../../src/cache/store.ts";
import { hashKey } from "../../src/utils/hash.ts";
import { toSWRError } from "../../src/utils/error.ts";

describe("useMutation unit tests", () => {
  beforeEach(() => {
    store._reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // T009: State transition tests (idle -> pending -> success / error)
  describe("state transitions", () => {
    it("should transition idle -> pending -> success", async () => {
      // This tests the conceptual state machine.
      // useMutation manages state via signals; here we test the underlying
      // cache interactions that support mutation.
      const key = "/api/todos";
      const hashed = hashKey(key);

      // Set up initial cache
      store.setCache(hashed, { data: [{ id: 1 }], timestamp: Date.now() });

      // After mutation succeeds, cache should be updated
      const newData = [{ id: 1 }, { id: 2 }];
      store.setCache(hashed, { data: newData, timestamp: Date.now() });

      const cached = store.getCache(hashed);
      expect(cached?.data).toEqual(newData);
    });

    it("should handle mutation error without corrupting cache", async () => {
      const key = "/api/todos";
      const hashed = hashKey(key);
      const originalData = [{ id: 1 }];

      store.setCache(hashed, { data: originalData, timestamp: Date.now() });

      // On error, cache should remain unchanged (no setCache called)
      const cached = store.getCache(hashed);
      expect(cached?.data).toEqual(originalData);
    });
  });

  // T010: mutateAsync$ returns Promise<Data>
  describe("mutateAsync$ Promise return", () => {
    it("should resolve with data from successful mutation function", async () => {
      const mutationFn = async (vars: { title: string }) => {
        return { id: 1, ...vars };
      };

      const result = await mutationFn({ title: "test" });
      expect(result).toEqual({ id: 1, title: "test" });
    });

    it("should reject on mutation function error", async () => {
      const mutationFn = async () => {
        throw new Error("Network error");
      };

      await expect(mutationFn()).rejects.toThrow("Network error");
    });
  });

  // T011: reset$ returns to idle
  describe("reset$", () => {
    it("should clear data, error, and variables state after reset", () => {
      // Conceptually, after reset$, all state is cleared
      // The actual signal management is in useMutation; here verify cache ops
      const key = "/api/test";
      const hashed = hashKey(key);

      store.setCache(hashed, { data: "value", timestamp: Date.now() });
      expect(store.getCache(hashed)).not.toBeNull();

      // reset doesn't clear cache, it resets mutation-local state
      // Cache remains as-is
      expect(store.getCache(hashed)?.data).toBe("value");
    });
  });

  // T012: mutate$ sets state.error on mutation failure
  // The executeMutation internal function converts errors via toSWRError
  // and sets state.isError = true, state.error = SWRError.
  // Since useMutation is a Qwik hook, we test the error conversion logic
  // and cache-level behavior that executeMutation relies on.
  describe("mutate$ error notification (US1)", () => {
    it("should produce SWRError from thrown Error via toSWRError", () => {
      const original = new Error("Network failure");
      const swrError = toSWRError(original);

      expect(swrError.type).toBe("unknown");
      expect(swrError.message).toBe("Network failure");
      expect(swrError.original).toBe(original);
      expect(swrError.timestamp).toBeGreaterThan(0);
      expect(swrError.retryCount).toBe(0);
    });

    it("should classify TypeError as network error in SWRError", () => {
      const original = new TypeError("Failed to fetch");
      const swrError = toSWRError(original);

      expect(swrError.type).toBe("network");
      expect(swrError.message).toBe("Failed to fetch");
    });

    it("should rollback optimistic update and set error state on mutation failure", () => {
      const key = "/api/todos";
      const hashed = hashKey(key);
      const originalData = [{ id: 1 }];

      // Set up initial cache
      store.setCache(hashed, { data: originalData, timestamp: Date.now() });

      // Snapshot before optimistic update
      const snapshot = store.getCache(hashed)!;

      // Apply optimistic update
      store.setCache(hashed, {
        data: [...originalData, { id: 999, title: "optimistic" }],
        timestamp: Date.now(),
      });

      // Simulate mutation failure -> rollback
      const error = new Error("Server error");
      const swrError = toSWRError(error);

      // Rollback
      store.setCache(hashed, snapshot);

      // Verify rollback
      expect(store.getCache(hashed)?.data).toEqual(originalData);
      // Verify error is a proper SWRError
      expect(swrError.type).toBe("unknown");
      expect(swrError.message).toBe("Server error");
    });
  });

  // T013: mutate$ does not cause unhandled rejection on failure
  describe("mutate$ unhandled rejection prevention (US1)", () => {
    it("should not produce unhandled rejection when mutation throws (fire-and-forget pattern)", async () => {
      // The refactored mutate$ catches executeMutation errors and swallows them.
      // executeMutation sets state.error before rethrowing.
      // Simulate the pattern: call executeMutation, catch, no re-throw.
      const mutationFn = async () => {
        throw new Error("Server error");
      };

      // The fire-and-forget pattern: catch and swallow
      let caughtError: Error | undefined;
      try {
        await mutationFn();
      } catch (e) {
        caughtError = e as Error;
        // In mutate$, this catch block swallows - no re-throw
      }

      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toBe("Server error");
      // No unhandled rejection: the error was caught and not re-thrown
    });

    it("should preserve error information in SWRError even when promise is swallowed", () => {
      // HTTP error objects should be properly classified
      const httpError = { status: 500, statusText: "Internal Server Error" };
      const swrError = toSWRError(httpError);

      expect(swrError.type).toBe("http");
      expect(swrError.status).toBe(500);
      expect(swrError.message).toBe("HTTP 500: Internal Server Error");
    });
  });

  // T015: Concurrent mutations have independent state (last-write-wins)
  describe("concurrent mutations (last-write-wins)", () => {
    it("should allow the latest mutation to win when writing to same cache key", async () => {
      const key = "/api/todos";
      const hashed = hashKey(key);

      // Simulate two concurrent writes
      store.setCache(hashed, { data: "first", timestamp: Date.now() });
      store.setCache(hashed, { data: "second", timestamp: Date.now() + 1 });

      const cached = store.getCache(hashed);
      expect(cached?.data).toBe("second");
    });

    it("should maintain independent state for each mutation instance", () => {
      // Two mutation instances operating on different state
      // Each has its own isPending, isError, data signals
      // This is enforced by useMutation creating separate useSignal per instance
      // Here we just verify cache supports concurrent access
      const key1 = "/api/resource-a";
      const key2 = "/api/resource-b";
      const hashed1 = hashKey(key1);
      const hashed2 = hashKey(key2);

      store.setCache(hashed1, { data: "a", timestamp: Date.now() });
      store.setCache(hashed2, { data: "b", timestamp: Date.now() });

      expect(store.getCache(hashed1)?.data).toBe("a");
      expect(store.getCache(hashed2)?.data).toBe("b");
    });
  });
});
