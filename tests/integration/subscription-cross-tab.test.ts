import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SWRError, SubscriptionStatus, SyncMessage } from "../../src/types/index.ts";
import { createSyncChannel } from "../../src/cache/sync-channel.ts";
import {
  subscriptionRegistry,
  type SubscriptionObserver,
} from "../../src/subscription/subscription-registry.ts";

// ═══════════════════════════════════════════════════════════════
// BroadcastChannel stub for multi-tab simulation
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function makeObserver(id: string): SubscriptionObserver & {
  dataHistory: unknown[];
  errorHistory: SWRError[];
  statusHistory: SubscriptionStatus[];
} {
  const dataHistory: unknown[] = [];
  const errorHistory: SWRError[] = [];
  const statusHistory: SubscriptionStatus[] = [];

  return {
    id,
    onData: vi.fn((data: unknown) => {
      dataHistory.push(data);
    }),
    onError: vi.fn((error: SWRError) => {
      errorHistory.push(error);
    }),
    onStatusChange: vi.fn((status: SubscriptionStatus) => {
      statusHistory.push(status);
    }),
    dataHistory,
    errorHistory,
    statusHistory,
  };
}

function makeSubscriberFn() {
  let capturedOnData: ((data: unknown) => void) | undefined;
  let capturedOnError: ((error: Error) => void) | undefined;
  const unsubscribe = vi.fn();

  const fn = vi.fn(
    (
      _key: string,
      callbacks: { onData: (data: unknown) => void; onError: (error: Error) => void },
    ) => {
      capturedOnData = callbacks.onData;
      capturedOnError = callbacks.onError;
      return { unsubscribe };
    },
  );

  return {
    fn,
    get capturedOnData() {
      return capturedOnData;
    },
    get capturedOnError() {
      return capturedOnError;
    },
    unsubscribe,
  };
}

/**
 * Create a "tab" with its own SyncChannel and SubscriptionRegistry init.
 * Since SubscriptionRegistry is a singleton, we can only have one real registry.
 * To simulate multi-tab, Tab A uses the real registry; Tab B manually receives
 * broadcast messages from Tab A via the FakeBroadcastChannel.
 *
 * For more realistic tests, we use a single registry (representing the current tab)
 * and verify that BroadcastChannel messages are correctly sent/received.
 */

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("Subscription cross-tab integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    channels.clear();
    (globalThis as any).BroadcastChannel = FakeBroadcastChannel;
    subscriptionRegistry._reset();
  });

  afterEach(() => {
    subscriptionRegistry._reset();
    vi.useRealTimers();
    channels.clear();
    delete (globalThis as any).BroadcastChannel;
  });

  it("2-tab data sync: Tab A subscribe + data -> Tab B receives via broadcast", async () => {
    // Tab A: real registry with sync channel
    const channelName = "sub-test";
    const tabAChannel = createSyncChannel(channelName, (msg) => {
      subscriptionRegistry.handleSyncMessage(msg);
    })!;
    expect(tabAChannel).not.toBeNull();

    subscriptionRegistry.initSync(tabAChannel, {
      dataSync: true,
      connectionDedup: false,
      heartbeatInterval: 3000,
      failoverTimeout: 10000,
    });

    // Tab A subscribes
    const observerA = makeObserver("obs-A");
    const subA = makeSubscriberFn();
    subscriptionRegistry.attach("s:ws-price", "ws-price", observerA, subA.fn, {
      maxRetries: 3,
      retryInterval: 1000,
    });

    // Tab B: simulated as a separate BroadcastChannel listener
    const tabBReceived: SyncMessage[] = [];
    const tabBChannel = new FakeBroadcastChannel(channelName);
    tabBChannel.onmessage = (event) => {
      tabBReceived.push(event.data as SyncMessage);
    };

    // Tab A receives data from WebSocket
    subA.capturedOnData!({ price: 100, ticker: "AAPL" });

    // Verify Tab A observer received data
    expect(observerA.dataHistory).toContainEqual({ price: 100, ticker: "AAPL" });

    // Verify Tab B received the broadcast
    const dataMsg = tabBReceived.find((m) => m.type === "sub-data") as any;
    expect(dataMsg).toBeDefined();
    expect(dataMsg.key).toBe("s:ws-price");
    expect(dataMsg.data).toEqual({ price: 100, ticker: "AAPL" });

    tabAChannel.close();
    tabBChannel.close();
  });

  it("2-tab data sync: Tab B sends data -> Tab A observer receives it", async () => {
    const channelName = "sub-test";
    const tabAChannel = createSyncChannel(channelName, (msg) => {
      subscriptionRegistry.handleSyncMessage(msg);
    })!;

    subscriptionRegistry.initSync(tabAChannel, {
      dataSync: true,
      connectionDedup: false,
      heartbeatInterval: 3000,
      failoverTimeout: 10000,
    });

    // Tab A subscribes
    const observerA = makeObserver("obs-A");
    const subA = makeSubscriberFn();
    subscriptionRegistry.attach("s:ws-price", "ws-price", observerA, subA.fn, {
      maxRetries: 3,
      retryInterval: 1000,
    });

    // Simulate Tab B sending sub-data
    const tabBChannel = new FakeBroadcastChannel(channelName);
    tabBChannel.postMessage({
      version: 1,
      type: "sub-data",
      tabId: "tab-B-id",
      key: "s:ws-price",
      data: { price: 200, ticker: "GOOG" },
      timestamp: Date.now(),
    });

    // Tab A observer should receive the remote data
    expect(observerA.onData).toHaveBeenCalledWith({ price: 200, ticker: "GOOG" });

    tabAChannel.close();
    tabBChannel.close();
  });

  it("leader election: leader Tab A resign -> Tab B (simulated) re-elects", async () => {
    const channelName = "sub-test";
    const tabAChannel = createSyncChannel(channelName, (msg) => {
      subscriptionRegistry.handleSyncMessage(msg);
    })!;

    subscriptionRegistry.initSync(tabAChannel, {
      dataSync: true,
      connectionDedup: true,
      heartbeatInterval: 1000,
      failoverTimeout: 5000,
    });

    // Set up Tab B listener BEFORE Tab A subscribes (to capture claim)
    const tabBReceived: SyncMessage[] = [];
    const tabBChannel = new FakeBroadcastChannel(channelName);
    tabBChannel.onmessage = (event) => {
      tabBReceived.push(event.data as SyncMessage);
    };

    // Tab A subscribes
    const observerA = makeObserver("obs-A");
    const subA = makeSubscriberFn();
    subscriptionRegistry.attach("s:ws-key", "ws-key", observerA, subA.fn, {
      maxRetries: 3,
      retryInterval: 1000,
    });

    // Wait for Tab A to win election
    await vi.advanceTimersByTimeAsync(100);

    // Verify Tab A started connection (is leader)
    expect(subA.fn).toHaveBeenCalledTimes(1);

    // Verify Tab B received the leader claim
    const claimMsg = tabBReceived.find((m) => m.type === "sub-leader-claim") as any;
    expect(claimMsg).toBeDefined();
    expect(claimMsg.key).toBe("s:ws-key");

    // Tab A detaches (resign)
    subscriptionRegistry.detach("s:ws-key", "obs-A");

    // Verify resign message was broadcast
    const resignMsg = tabBReceived.find((m) => m.type === "sub-leader-resign") as any;
    expect(resignMsg).toBeDefined();

    tabAChannel.close();
    tabBChannel.close();
  });

  it("heartbeat: leader sends periodic heartbeats visible to other tabs", async () => {
    const channelName = "sub-test";
    const tabAChannel = createSyncChannel(channelName, (msg) => {
      subscriptionRegistry.handleSyncMessage(msg);
    })!;

    subscriptionRegistry.initSync(tabAChannel, {
      dataSync: true,
      connectionDedup: true,
      heartbeatInterval: 1000,
      failoverTimeout: 5000,
    });

    const observerA = makeObserver("obs-A");
    const subA = makeSubscriberFn();
    subscriptionRegistry.attach("s:ws-key", "ws-key", observerA, subA.fn, {
      maxRetries: 3,
      retryInterval: 1000,
    });

    // Win election
    await vi.advanceTimersByTimeAsync(100);

    const tabBReceived: SyncMessage[] = [];
    const tabBChannel = new FakeBroadcastChannel(channelName);
    tabBChannel.onmessage = (event) => {
      tabBReceived.push(event.data as SyncMessage);
    };

    // Advance time for 2 heartbeat intervals
    await vi.advanceTimersByTimeAsync(2000);

    const heartbeats = tabBReceived.filter((m) => m.type === "sub-leader-heartbeat");
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);

    tabAChannel.close();
    tabBChannel.close();
  });

  it("error sync: Tab A error -> broadcast -> visible to Tab B", async () => {
    const channelName = "sub-test";
    const tabAChannel = createSyncChannel(channelName, (msg) => {
      subscriptionRegistry.handleSyncMessage(msg);
    })!;

    subscriptionRegistry.initSync(tabAChannel, {
      dataSync: true,
      connectionDedup: false,
      heartbeatInterval: 3000,
      failoverTimeout: 10000,
    });

    const observerA = makeObserver("obs-A");
    const subA = makeSubscriberFn();
    subscriptionRegistry.attach("s:ws-key", "ws-key", observerA, subA.fn, {
      maxRetries: 3,
      retryInterval: 1000,
    });

    const tabBReceived: SyncMessage[] = [];
    const tabBChannel = new FakeBroadcastChannel(channelName);
    tabBChannel.onmessage = (event) => {
      tabBReceived.push(event.data as SyncMessage);
    };

    // Trigger error
    subA.capturedOnError!(new Error("ws connection lost"));

    const errorMsg = tabBReceived.find((m) => m.type === "sub-error") as any;
    expect(errorMsg).toBeDefined();
    expect(errorMsg.key).toBe("s:ws-key");
    expect(errorMsg.error.message).toBe("ws connection lost");

    tabAChannel.close();
    tabBChannel.close();
  });
});
