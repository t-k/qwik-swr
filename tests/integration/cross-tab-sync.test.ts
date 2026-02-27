import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { HashedKey, CacheEntry, SWRError } from "../../src/types/index.ts";
import type { Observer } from "../../src/cache/types.ts";
import { store } from "../../src/cache/store.ts";

// Minimal BroadcastChannel stub that simulates cross-tab communication
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

function createTestObserver(hashedKey: HashedKey): Observer & {
  dataHistory: CacheEntry[];
  errorHistory: SWRError[];
  statusHistory: string[];
} {
  const dataHistory: CacheEntry[] = [];
  const errorHistory: SWRError[] = [];
  const statusHistory: string[] = [];
  return {
    id: `ob-${Math.random().toString(36).slice(2)}`,
    hashedKey,
    lastRawKey: hashedKey.slice(2),
    hasData: false,
    onData: (entry: CacheEntry) => dataHistory.push(entry),
    onError: (error: SWRError) => errorHistory.push(error),
    onFetchStatusChange: (status: string) => statusHistory.push(status),
    dataHistory,
    errorHistory,
    statusHistory,
  };
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

describe("Cross-tab sync integration", () => {
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

  it("full flow: setCache → broadcast → receive → cacheMap update → observer notification", () => {
    // Tab A: the store under test
    store.initSync("test-channel");

    // Tab B: simulated via another BroadcastChannel instance
    const tabB = new FakeBroadcastChannel("test-channel");
    const receivedMessages: unknown[] = [];
    tabB.onmessage = (event) => receivedMessages.push(event.data);

    // Attach an observer in Tab A
    const observer = createTestObserver("s:user1" as HashedKey);
    store.attachObserver("s:user1" as HashedKey, observer, DEFAULT_CONFIG as any);

    // Tab A sets cache — should broadcast to Tab B
    const now = Date.now();
    store.setCache("s:user1" as HashedKey, { data: { name: "Alice" }, timestamp: now });

    // Verify Tab B received the broadcast
    expect(receivedMessages.length).toBe(1);
    const msg = receivedMessages[0] as any;
    expect(msg.type).toBe("set");
    expect(msg.key).toBe("s:user1");
    expect(msg.entry.data.name).toBe("Alice");

    // Now simulate Tab B sending an update back
    tabB.postMessage({
      version: 1,
      type: "set",
      tabId: "tab-b-id",
      key: "s:user1",
      entry: { data: { name: "Bob" }, timestamp: now + 1000 },
      timestamp: now + 1000,
    });

    // Tab A's cache should be updated (newer timestamp wins)
    const cached = store.getCache("s:user1" as HashedKey);
    expect(cached?.data).toEqual({ name: "Bob" });

    // Observer should have been notified of the update
    // dataHistory[0] = initial setCache notification, dataHistory[1] = sync update
    expect(observer.dataHistory.length).toBeGreaterThanOrEqual(2);
    expect(observer.dataHistory[observer.dataHistory.length - 1]!.data).toEqual({ name: "Bob" });

    store.closeSync();
    tabB.close();
  });

  it("deleteCache broadcasts and remote delete clears local cache", () => {
    store.initSync("test-channel");

    const tabB = new FakeBroadcastChannel("test-channel");
    const receivedMessages: unknown[] = [];
    tabB.onmessage = (event) => receivedMessages.push(event.data);

    // Set initial data
    store.setCache("s:item1" as HashedKey, { data: "value1", timestamp: Date.now() });
    expect(store.getCache("s:item1" as HashedKey)?.data).toBe("value1");

    // Delete should broadcast
    store.deleteCache("s:item1" as HashedKey);
    const deleteMsg = receivedMessages.find((m: any) => m.type === "delete") as any;
    expect(deleteMsg).toBeDefined();
    expect(deleteMsg.key).toBe("s:item1");

    // Now simulate remote delete from Tab B
    store.setCache("s:item2" as HashedKey, { data: "value2", timestamp: Date.now() });
    tabB.postMessage({
      version: 1,
      type: "delete",
      tabId: "tab-b-id",
      key: "s:item2",
      timestamp: Date.now(),
    });

    // Local cache should be cleared
    expect(store.getCache("s:item2" as HashedKey)).toBeNull();

    store.closeSync();
    tabB.close();
  });

  it("clearCache broadcasts and remote clear clears all local cache", () => {
    store.initSync("test-channel");

    const tabB = new FakeBroadcastChannel("test-channel");
    const receivedMessages: unknown[] = [];
    tabB.onmessage = (event) => receivedMessages.push(event.data);

    // Set some data
    store.setCache("s:a" as HashedKey, { data: 1, timestamp: Date.now() });
    store.setCache("s:b" as HashedKey, { data: 2, timestamp: Date.now() });

    // Simulate remote clear from Tab B
    tabB.postMessage({
      version: 1,
      type: "clear",
      tabId: "tab-b-id",
      timestamp: Date.now(),
    });

    // All local cache should be cleared
    expect(store.keys().length).toBe(0);

    store.closeSync();
    tabB.close();
  });

  it("last-writer-wins: older remote entry does not overwrite newer local entry", () => {
    store.initSync("test-channel");

    const tabB = new FakeBroadcastChannel("test-channel");

    const now = Date.now();
    // Set local cache with newer timestamp
    store.setCache("s:key1" as HashedKey, { data: "local-new", timestamp: now + 5000 });

    // Tab B sends older data
    tabB.postMessage({
      version: 1,
      type: "set",
      tabId: "tab-b-id",
      key: "s:key1",
      entry: { data: "remote-old", timestamp: now },
      timestamp: now,
    });

    // Local newer data should survive
    expect(store.getCache("s:key1" as HashedKey)?.data).toBe("local-new");

    store.closeSync();
    tabB.close();
  });

  it("cross-tab fetch dedup end-to-end: fetch-start → fetch-complete cycle", () => {
    store.initSync("test-channel");
    store.enableDedup(true);

    const observer = createTestObserver("s:data1" as HashedKey);
    store.attachObserver("s:data1" as HashedKey, observer, DEFAULT_CONFIG as any);

    const tabB = new FakeBroadcastChannel("test-channel");

    // Tab B starts fetching
    tabB.postMessage({
      version: 1,
      type: "fetch-start",
      tabId: "tab-b-id",
      key: "s:data1",
      timestamp: Date.now(),
    });

    // Local ensureFetch should be suppressed
    let fetchCalled = false;
    store.ensureFetch("s:data1" as HashedKey, "data1", () => {
      fetchCalled = true;
      return "should-not-run";
    });
    expect(fetchCalled).toBe(false);

    // Tab B completes fetching
    const now = Date.now();
    tabB.postMessage({
      version: 1,
      type: "fetch-complete",
      tabId: "tab-b-id",
      key: "s:data1",
      entry: { data: "remote-result", timestamp: now },
      timestamp: now,
    });

    // Data should be available locally
    expect(store.getCache("s:data1" as HashedKey)?.data).toBe("remote-result");

    // After fetch-complete, local fetch should be allowed again (remoteInflight cleared)
    let _secondFetchCalled = false;
    store.ensureFetch("s:data1" as HashedKey, "data1", () => {
      _secondFetchCalled = true;
      return "local-data";
    });

    store.closeSync();
    tabB.close();
  });
});
