import { describe, it, expect, beforeEach } from "vitest";
import type { HashedKey } from "../../src/types/index.ts";
import { store } from "../../src/cache/store.ts";
import { makeObserver, makeOptions, resetObserverIdCounter } from "../helpers/index.ts";

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("deleteCache type safety (US2)", () => {
  beforeEach(() => {
    store._reset();
    resetObserverIdCounter();
  });

  it("should notify observer with { data: undefined, timestamp: 0 } without type assertion", () => {
    const key: HashedKey = "delete-key-1" as HashedKey;
    const observer = makeObserver(key);
    const opts = makeOptions();
    store.attachObserver(key, observer, opts);

    // Set initial cache
    store.setCache(key, { data: "some-data", timestamp: 100 });

    // Delete cache
    store.deleteCache(key);

    // Observer should receive { data: undefined, timestamp: 0 }
    expect(observer.onData).toHaveBeenCalledWith({ data: undefined, timestamp: 0 });
  });

  it("should set observer.hasData to false after deleteCache", () => {
    const key: HashedKey = "delete-key-2" as HashedKey;
    const observer = makeObserver(key);
    const opts = makeOptions();
    store.attachObserver(key, observer, opts);

    // Set initial cache - this will set hasData = true
    store.setCache(key, { data: "initial", timestamp: 100 });
    expect(observer.hasData).toBe(true);

    // Delete cache
    store.deleteCache(key);

    // hasData should be false
    expect(observer.hasData).toBe(false);
  });

  it("should handle multiple observers on deleteCache", () => {
    const key: HashedKey = "delete-key-3" as HashedKey;
    const observer1 = makeObserver(key);
    const observer2 = makeObserver(key);
    const opts = makeOptions();
    store.attachObserver(key, observer1, opts);
    store.attachObserver(key, observer2, opts);

    store.setCache(key, { data: "shared-data", timestamp: 100 });

    store.deleteCache(key);

    expect(observer1.onData).toHaveBeenCalledWith({ data: undefined, timestamp: 0 });
    expect(observer2.onData).toHaveBeenCalledWith({ data: undefined, timestamp: 0 });
    expect(observer1.hasData).toBe(false);
    expect(observer2.hasData).toBe(false);
  });
});
