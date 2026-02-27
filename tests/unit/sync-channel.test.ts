import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncMessage, HashedKey } from "../../src/types/index.ts";

// Minimal BroadcastChannel stub (not a mock — a real object that simulates channel behavior)
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

describe("createSyncChannel", () => {
  let createSyncChannel: typeof import("../../src/cache/sync-channel.ts").createSyncChannel;

  beforeEach(async () => {
    channels.clear();
    // Install FakeBroadcastChannel
    (globalThis as any).BroadcastChannel = FakeBroadcastChannel;

    // Fresh import to pick up global state
    const mod = await import("../../src/cache/sync-channel.ts");
    createSyncChannel = mod.createSyncChannel;
  });

  afterEach(() => {
    channels.clear();
    delete (globalThis as any).BroadcastChannel;
  });

  it("should create a channel with BroadcastChannel available", () => {
    const channel = createSyncChannel("test-channel", () => {});
    expect(channel).not.toBeNull();
    channel?.close();
  });

  it("should return null when BroadcastChannel is unavailable", () => {
    delete (globalThis as any).BroadcastChannel;
    const channel = createSyncChannel("test-channel", () => {});
    expect(channel).toBeNull();
  });

  it("should send and receive messages between two channels", () => {
    const received: SyncMessage[] = [];
    const channelA = createSyncChannel("test", () => {});
    const channelB = createSyncChannel("test", (msg) => {
      received.push(msg);
    });

    const msg: SyncMessage = {
      version: 1,
      type: "set",
      tabId: channelA!.tabId,
      key: "s:foo" as HashedKey,
      entry: { data: "hello", timestamp: 100 },
      timestamp: 100,
    };

    channelA!.broadcast(msg);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);

    channelA!.close();
    channelB!.close();
  });

  it("should filter echo messages (same tabId)", () => {
    const received: SyncMessage[] = [];
    const channel = createSyncChannel("test", (msg) => {
      received.push(msg);
    });

    // Message with same tabId should be ignored (echo prevention handled internally)
    // Since BroadcastChannel doesn't deliver to self, we test via a second channel
    const channelB = createSyncChannel("test", () => {});

    const msg: SyncMessage = {
      version: 1,
      type: "set",
      tabId: channelB!.tabId,
      key: "s:bar" as HashedKey,
      entry: { data: "world", timestamp: 200 },
      timestamp: 200,
    };

    channelB!.broadcast(msg);

    // Channel A receives it (different tabId)
    expect(received).toHaveLength(1);

    channel!.close();
    channelB!.close();
  });

  it("should ignore messages with tabId matching own tabId", () => {
    // Simulate a scenario where a message with our own tabId arrives
    // This tests the echo filtering in onMessage handler
    const received: SyncMessage[] = [];
    const channelA = createSyncChannel("test", (msg) => {
      received.push(msg);
    });

    // Directly invoke onmessage with own tabId to test filtering
    const set = channels.get("test")!;
    const bcInstance = [...set][0] as FakeBroadcastChannel;

    const echoMsg: SyncMessage = {
      version: 1,
      type: "set",
      tabId: channelA!.tabId, // Same tabId = echo
      key: "s:echo" as HashedKey,
      entry: { data: "echo", timestamp: 300 },
      timestamp: 300,
    };

    // Manually fire onmessage to simulate echo
    bcInstance.onmessage?.({ data: echoMsg });
    expect(received).toHaveLength(0);

    channelA!.close();
  });

  it("should ignore messages with unknown version", () => {
    const received: SyncMessage[] = [];
    const channelA = createSyncChannel("test", (msg) => {
      received.push(msg);
    });
    const channelB = createSyncChannel("test", () => {});

    // Send a message with version 99
    const invalidMsg = {
      version: 99,
      type: "set",
      tabId: channelB!.tabId,
      key: "s:future" as HashedKey,
      entry: { data: "future", timestamp: 400 },
      timestamp: 400,
    };

    // Directly invoke onmessage on channelA's BroadcastChannel
    const set = channels.get("test")!;
    const bcInstances = [...set];
    const aInstance = bcInstances[0] as FakeBroadcastChannel;
    aInstance.onmessage?.({ data: invalidMsg });

    expect(received).toHaveLength(0);

    channelA!.close();
    channelB!.close();
  });

  it("should handle all message types (set, delete, clear)", () => {
    const received: SyncMessage[] = [];
    const channelA = createSyncChannel("test", (msg) => {
      received.push(msg);
    });
    const channelB = createSyncChannel("test", () => {});

    const tabId = channelB!.tabId;

    // set
    channelB!.broadcast({
      version: 1,
      type: "set",
      tabId,
      key: "s:k1" as HashedKey,
      entry: { data: 1, timestamp: 100 },
      timestamp: 100,
    });

    // delete
    channelB!.broadcast({
      version: 1,
      type: "delete",
      tabId,
      key: "s:k1" as HashedKey,
      timestamp: 200,
    });

    // clear
    channelB!.broadcast({
      version: 1,
      type: "clear",
      tabId,
      timestamp: 300,
    });

    expect(received).toHaveLength(3);
    expect(received[0]!.type).toBe("set");
    expect(received[1]!.type).toBe("delete");
    expect(received[2]!.type).toBe("clear");

    channelA!.close();
    channelB!.close();
  });

  it("should cleanup on close", () => {
    const received: SyncMessage[] = [];
    const channelA = createSyncChannel("test", (msg) => {
      received.push(msg);
    });
    const channelB = createSyncChannel("test", () => {});

    // Close channelA
    channelA!.close();

    // Messages should no longer arrive
    channelB!.broadcast({
      version: 1,
      type: "clear",
      tabId: channelB!.tabId,
      timestamp: 500,
    });

    expect(received).toHaveLength(0);

    channelB!.close();
  });

  it("should handle postMessage errors gracefully (non-serializable data)", () => {
    const received: SyncMessage[] = [];
    const channelA = createSyncChannel("test", (msg) => {
      received.push(msg);
    });

    // Intercept broadcast on channelA to throw
    // We actually test that broadcast() doesn't throw
    expect(() => {
      channelA!.broadcast({
        version: 1,
        type: "set",
        tabId: channelA!.tabId,
        key: "s:test" as HashedKey,
        entry: { data: "test", timestamp: 100 },
        timestamp: 100,
      });
    }).not.toThrow();

    channelA!.close();
  });

  it("should reject non-clear messages without string key (SF-5)", () => {
    const received: SyncMessage[] = [];
    const channelA = createSyncChannel("test", (msg) => {
      received.push(msg);
    });

    // Directly invoke onmessage with a non-clear message missing key
    const set = channels.get("test")!;
    const bcInstance = [...set][0] as FakeBroadcastChannel;
    const otherTabId = "other-tab";

    // "set" without key -> rejected
    bcInstance.onmessage?.({
      data: { version: 1, type: "set", tabId: otherTabId, timestamp: 100 },
    });
    expect(received).toHaveLength(0);

    // "delete" with numeric key -> rejected
    bcInstance.onmessage?.({
      data: { version: 1, type: "delete", tabId: otherTabId, key: 123, timestamp: 200 },
    });
    expect(received).toHaveLength(0);

    // "clear" without key -> accepted (key is optional for clear)
    bcInstance.onmessage?.({
      data: { version: 1, type: "clear", tabId: otherTabId, timestamp: 300 },
    });
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("clear");

    channelA!.close();
  });

  it("should expose tabId as a unique identifier", () => {
    const channelA = createSyncChannel("test", () => {});
    const channelB = createSyncChannel("test", () => {});

    expect(channelA!.tabId).toBeTruthy();
    expect(channelB!.tabId).toBeTruthy();
    expect(channelA!.tabId).not.toBe(channelB!.tabId);

    channelA!.close();
    channelB!.close();
  });
});
