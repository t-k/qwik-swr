import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncMessage, CacheEntry, HashedKey, SWRError } from "../../src/types/index.ts";
import type { Observer } from "../../src/cache/types.ts";
import { store } from "../../src/cache/store.ts";

// Minimal BroadcastChannel stub for sync tests
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
    id: `test-${Math.random().toString(36).slice(2)}`,
    hashedKey,
    lastRawKey: hashedKey.slice(2), // strip prefix
    hasData: false,
    onData: (entry: CacheEntry) => {
      dataHistory.push(entry);
    },
    onError: (error: SWRError) => {
      errorHistory.push(error);
    },
    onFetchStatusChange: (status: string) => {
      statusHistory.push(status);
    },
    dataHistory,
    errorHistory,
    statusHistory,
  };
}

const DEFAULT_RESOLVED_CONFIG = {
  enabled: true,
  eagerness: "visible" as const,
  staleTime: 30_000,
  cacheTime: 300_000,
  dedupingInterval: 2_000,
  revalidateOn: [] as string[],
  refreshInterval: 0,
  retry: 3,
  retryInterval: 1000,
  timeout: 30_000,
};

describe("CacheStore sync integration", () => {
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

  describe("broadcast on cache mutations", () => {
    it("should broadcast SyncMessage(type='set') on setCache", () => {
      const messages: SyncMessage[] = [];

      // Initialize sync on the store
      store.initSync("test-channel");

      // Create a second channel to receive broadcasts
      const receiver = new FakeBroadcastChannel("test-channel");
      receiver.onmessage = (event) => {
        messages.push(event.data as SyncMessage);
      };

      store.setCache("s:foo" as HashedKey, { data: "bar", timestamp: 100 });

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe("set");
      expect(messages[0]!.version).toBe(1);
      if (messages[0]!.type === "set") {
        expect(messages[0]!.key).toBe("s:foo");
        expect(messages[0]!.entry.data).toBe("bar");
      }

      store.closeSync();
      receiver.close();
    });

    it("should broadcast SyncMessage(type='delete') on deleteCache", () => {
      const messages: SyncMessage[] = [];
      store.initSync("test-channel");

      const receiver = new FakeBroadcastChannel("test-channel");
      receiver.onmessage = (event) => {
        messages.push(event.data as SyncMessage);
      };

      // Set then delete
      store.setCache("s:foo" as HashedKey, { data: "bar", timestamp: 100 });
      messages.length = 0; // clear set message

      store.deleteCache("s:foo" as HashedKey);

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe("delete");
      if (messages[0]!.type === "delete") {
        expect(messages[0]!.key).toBe("s:foo");
      }

      store.closeSync();
      receiver.close();
    });

    it("should broadcast SyncMessage(type='clear') on clearCache", () => {
      const messages: SyncMessage[] = [];
      store.initSync("test-channel");

      const receiver = new FakeBroadcastChannel("test-channel");
      receiver.onmessage = (event) => {
        messages.push(event.data as SyncMessage);
      };

      store.clearCache();

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe("clear");

      store.closeSync();
      receiver.close();
    });
  });

  describe("receiving sync messages", () => {
    it("should update cacheMap on received 'set' message with newer timestamp", () => {
      store.initSync("test-channel");

      // Set an initial entry with old timestamp
      store.setCache("s:key1" as HashedKey, { data: "old", timestamp: 50 });

      // Simulate receiving a 'set' from another tab
      const sender = new FakeBroadcastChannel("test-channel");
      const msg: SyncMessage = {
        version: 1,
        type: "set",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        entry: { data: "new-from-other-tab", timestamp: 200 },
        timestamp: 200,
      };
      sender.postMessage(msg);

      // cacheMap should be updated with newer data
      const cached = store.getCache("s:key1" as HashedKey);
      expect(cached?.data).toBe("new-from-other-tab");
      expect(cached?.timestamp).toBe(200);

      store.closeSync();
      sender.close();
    });

    it("should update cacheMap when received 'set' message has EQUAL timestamp (remote wins on tie)", () => {
      store.initSync("test-channel");

      // Set an initial entry
      store.setCache("s:key1" as HashedKey, { data: "local", timestamp: 200 });

      // Simulate receiving a 'set' from another tab with SAME timestamp
      const sender = new FakeBroadcastChannel("test-channel");
      const msg: SyncMessage = {
        version: 1,
        type: "set",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        entry: { data: "remote-same-ts", timestamp: 200 },
        timestamp: 200,
      };
      sender.postMessage(msg);

      // Remote should win on tie (strictly > comparison means equal timestamps are accepted)
      const cached = store.getCache("s:key1" as HashedKey);
      expect(cached?.data).toBe("remote-same-ts");

      store.closeSync();
      sender.close();
    });

    it("should NOT update cacheMap when received message has older timestamp (last-writer-wins)", () => {
      store.initSync("test-channel");

      // Set an entry with newer timestamp
      store.setCache("s:key1" as HashedKey, { data: "newer-local", timestamp: 500 });

      // Simulate receiving an older 'set' from another tab
      const sender = new FakeBroadcastChannel("test-channel");
      const msg: SyncMessage = {
        version: 1,
        type: "set",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        entry: { data: "older-remote", timestamp: 100 },
        timestamp: 100,
      };
      sender.postMessage(msg);

      // cacheMap should NOT be updated (local is newer)
      const cached = store.getCache("s:key1" as HashedKey);
      expect(cached?.data).toBe("newer-local");

      store.closeSync();
      sender.close();
    });

    it("should notify observers when remote 'set' is applied", () => {
      store.initSync("test-channel");

      const observer = createTestObserver("s:key1" as HashedKey);
      store.attachObserver("s:key1" as HashedKey, observer, DEFAULT_RESOLVED_CONFIG as any);

      // Simulate receiving a 'set' from another tab
      const sender = new FakeBroadcastChannel("test-channel");
      sender.postMessage({
        version: 1,
        type: "set",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        entry: { data: "remote-data", timestamp: 200 },
        timestamp: 200,
      });

      // Observer should receive the new data
      expect(observer.dataHistory.length).toBeGreaterThanOrEqual(1);
      const lastData = observer.dataHistory.at(-1);
      expect(lastData?.data).toBe("remote-data");

      store.closeSync();
      sender.close();
    });

    it("should handle received 'delete' message", () => {
      store.initSync("test-channel");

      store.setCache("s:key1" as HashedKey, { data: "existing", timestamp: 100 });

      const sender = new FakeBroadcastChannel("test-channel");
      sender.postMessage({
        version: 1,
        type: "delete",
        tabId: "other-tab",
        key: "s:key1" as HashedKey,
        timestamp: 200,
      });

      expect(store.getCache("s:key1" as HashedKey)).toBeNull();

      store.closeSync();
      sender.close();
    });

    it("should handle received 'clear' message", () => {
      store.initSync("test-channel");

      store.setCache("s:key1" as HashedKey, { data: "a", timestamp: 100 });
      store.setCache("s:key2" as HashedKey, { data: "b", timestamp: 100 });

      const sender = new FakeBroadcastChannel("test-channel");
      sender.postMessage({
        version: 1,
        type: "clear",
        tabId: "other-tab",
        timestamp: 200,
      });

      expect(store.getCache("s:key1" as HashedKey)).toBeNull();
      expect(store.getCache("s:key2" as HashedKey)).toBeNull();

      store.closeSync();
      sender.close();
    });
  });

  describe("opt-out", () => {
    it("should not broadcast when sync is not initialized", () => {
      // Do NOT call store.initSync()
      const messages: SyncMessage[] = [];

      const receiver = new FakeBroadcastChannel("test-channel");
      receiver.onmessage = (event) => {
        messages.push(event.data as SyncMessage);
      };

      store.setCache("s:foo" as HashedKey, { data: "bar", timestamp: 100 });
      expect(messages).toHaveLength(0);

      receiver.close();
    });
  });

  describe("cleanup", () => {
    it("should stop broadcasting after closeSync", () => {
      const messages: SyncMessage[] = [];
      store.initSync("test-channel");

      const receiver = new FakeBroadcastChannel("test-channel");
      receiver.onmessage = (event) => {
        messages.push(event.data as SyncMessage);
      };

      store.closeSync();

      store.setCache("s:foo" as HashedKey, { data: "bar", timestamp: 100 });
      expect(messages).toHaveLength(0);

      receiver.close();
    });

    it("should cleanup sync on _reset", () => {
      store.initSync("test-channel");

      const messages: SyncMessage[] = [];
      const receiver = new FakeBroadcastChannel("test-channel");
      receiver.onmessage = (event) => {
        messages.push(event.data as SyncMessage);
      };

      store._reset();

      // After _reset, channel should be null
      // setCache would need to be called on new data since cacheMap is cleared
      store.setCache("s:foo" as HashedKey, { data: "bar", timestamp: 100 });
      expect(messages).toHaveLength(0);

      receiver.close();
    });
  });
});
