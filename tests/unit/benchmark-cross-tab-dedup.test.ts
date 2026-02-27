import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { HashedKey, SyncMessage } from "../../src/types/index.ts";
import type { Observer } from "../../src/cache/types.ts";
import { store } from "../../src/cache/store.ts";

// Minimal BroadcastChannel stub (synchronous postMessage)
const channels: Map<
  string,
  Set<{ onmessage: ((event: { data: unknown }) => void) | null }>
> = new Map();

class FakeBroadcastChannel {
  name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    const set = channels.get(name) ?? new Set();
    set.add(this);
    channels.set(name, set);
  }

  postMessage(data: unknown): void {
    const set = channels.get(this.name);
    if (!set) return;
    for (const ch of set) {
      if (ch !== this && ch.onmessage) {
        ch.onmessage({ data: structuredClone(data) });
      }
    }
  }

  close(): void {
    const set = channels.get(this.name);
    if (set) {
      set.delete(this);
      if (set.size === 0) channels.delete(this.name);
    }
  }
}

const DEFAULT_CONFIG = {
  enabled: true,
  eagerness: "visible" as const,
  staleTime: 0,
  cacheTime: 300_000,
  dedupingInterval: 2_000,
  revalidateOn: [] as string[],
  refreshInterval: 0,
  retry: 0,
  retryInterval: 1000,
  timeout: 30_000,
};

function createObserver(hashedKey: HashedKey, idPrefix: string): Observer {
  return {
    id: `${idPrefix}-${Math.random().toString(36).slice(2)}`,
    hashedKey,
    lastRawKey: hashedKey.slice(2),
    hasData: false,
    onData: () => {},
    onError: () => {},
    onFetchStatusChange: () => {},
  };
}

describe("SC-002: Cross-tab fetch dedup reduces network requests >=50%", () => {
  const KEY_COUNT = 10;
  const KEYS = Array.from({ length: KEY_COUNT }, (_, i) => `key${i}`);
  const HASHED = KEYS.map((k) => `s:${k}` as HashedKey);

  beforeEach(() => {
    channels.clear();
    (globalThis as any).BroadcastChannel = FakeBroadcastChannel;
    store._reset();
  });

  afterEach(() => {
    store._reset();
    channels.clear();
    delete (globalThis as any).BroadcastChannel;
  });

  it("dedup enabled: 0 local fetches when all keys have remote inflight (100% reduction)", () => {
    // Scenario A: No dedup — both "tabs" fetch independently
    store.initSync("bench-a");
    // No enableDedup

    let fetchCountA = 0;
    for (let i = 0; i < KEY_COUNT; i++) {
      const ob = createObserver(HASHED[i]!, "a");
      store.attachObserver(HASHED[i]!, ob, DEFAULT_CONFIG as any);
    }

    // Simulate other tab sending fetch-start (ignored without dedup)
    const senderA = new FakeBroadcastChannel("bench-a");
    for (let i = 0; i < KEY_COUNT; i++) {
      senderA.postMessage({
        version: 1,
        type: "fetch-start",
        tabId: "other-tab",
        key: HASHED[i]!,
        timestamp: Date.now(),
      } satisfies SyncMessage);
    }

    // Tab A calls ensureFetch for all keys (should all proceed — dedup disabled)
    for (let i = 0; i < KEY_COUNT; i++) {
      store.ensureFetch(HASHED[i]!, KEYS[i]!, () => {
        fetchCountA++;
        return `data-${i}`;
      });
    }

    store.closeSync();
    senderA.close();

    // Scenario B: With dedup
    store._reset();
    channels.clear();

    store.initSync("bench-b");
    store.enableDedup(true);

    let fetchCountB = 0;
    for (let i = 0; i < KEY_COUNT; i++) {
      const ob = createObserver(HASHED[i]!, "b");
      store.attachObserver(HASHED[i]!, ob, DEFAULT_CONFIG as any);
    }

    // Other tab sends fetch-start for all keys
    const senderB = new FakeBroadcastChannel("bench-b");
    for (let i = 0; i < KEY_COUNT; i++) {
      senderB.postMessage({
        version: 1,
        type: "fetch-start",
        tabId: "other-tab",
        key: HASHED[i]!,
        timestamp: Date.now(),
      } satisfies SyncMessage);
    }

    // Tab A calls ensureFetch (should all be suppressed)
    for (let i = 0; i < KEY_COUNT; i++) {
      store.ensureFetch(HASHED[i]!, KEYS[i]!, () => {
        fetchCountB++;
        return `data-${i}`;
      });
    }

    store.closeSync();
    senderB.close();

    // Assert: Scenario A fetched all 10, Scenario B fetched 0
    expect(fetchCountA).toBe(KEY_COUNT);
    expect(fetchCountB).toBe(0);

    // Reduction >= 50%
    const reduction = (fetchCountA - fetchCountB) / fetchCountA;
    expect(reduction).toBeGreaterThanOrEqual(0.5);
  });
});
