import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SWRError, SubscriptionStatus } from "../../src/types/index.ts";
import type { SyncChannelApi } from "../../src/cache/sync-channel.ts";
import type { SyncMessage } from "../../src/types/index.ts";
import {
  subscriptionRegistry,
  type SubscriptionObserver,
} from "../../src/subscription/subscription-registry.ts";

// ═══════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════

function createFakeChannel(tabId = "tab-A"): SyncChannelApi & {
  messages: SyncMessage[];
  triggerMessage: (msg: SyncMessage) => void;
} {
  const messages: SyncMessage[] = [];
  return {
    tabId,
    messages,
    broadcast(msg: SyncMessage) {
      messages.push(msg);
    },
    close() {},
    triggerMessage(_msg: SyncMessage) {
      // This is for external simulation; actual routing is done by tests calling handleSyncMessage
    },
  };
}

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

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("SubscriptionRegistry + sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    subscriptionRegistry._reset();
  });

  afterEach(() => {
    subscriptionRegistry._reset();
    vi.useRealTimers();
  });

  // ─── Backward compatibility ───

  describe("backward compatibility", () => {
    it("should work exactly the same without initSync", () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      expect(sub.fn).toHaveBeenCalledTimes(1);
      sub.capturedOnData!({ value: 1 });
      expect(observer.onData).toHaveBeenCalledWith({ value: 1 });

      subscriptionRegistry.detach("s:key1", "obs-1");
      expect(sub.unsubscribe).toHaveBeenCalled();
    });

    it("should allow attach/detach before initSync is called", () => {
      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      // attach before initSync
      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      expect(sub.fn).toHaveBeenCalledTimes(1);
      sub.capturedOnData!("before-sync");
      expect(observer.onData).toHaveBeenCalledWith("before-sync");

      subscriptionRegistry.detach("s:key1", "obs-1");
    });
  });

  // ─── Data sync mode ───

  describe("data sync mode (subscriptionSync only)", () => {
    it("should broadcast data to other tabs when leader receives data", async () => {
      const channel = createFakeChannel("tab-A");
      subscriptionRegistry.initSync(channel, {
        dataSync: true,
        connectionDedup: false,
        heartbeatInterval: 3000,
        failoverTimeout: 10000,
      });

      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Simulate data arrival from WebSocket
      sub.capturedOnData!({ value: 42 });

      // Should have broadcast sub-data
      const dataMsg = channel.messages.find((m) => m.type === "sub-data");
      expect(dataMsg).toBeDefined();
      if (dataMsg && dataMsg.type === "sub-data") {
        expect(dataMsg.key).toBe("s:key1");
        expect(dataMsg.data).toEqual({ value: 42 });
      }
    });

    it("should deliver remote data to local observers (follower tab)", async () => {
      const channel = createFakeChannel("tab-B");
      subscriptionRegistry.initSync(channel, {
        dataSync: true,
        connectionDedup: false,
        heartbeatInterval: 3000,
        failoverTimeout: 10000,
      });

      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Simulate receiving remote data from tab-A
      subscriptionRegistry.handleSyncMessage({
        version: 1,
        type: "sub-data",
        tabId: "tab-A",
        key: "s:key1",
        data: { remote: true },
        timestamp: Date.now(),
      });

      expect(observer.onData).toHaveBeenCalledWith({ remote: true });
    });

    it("should sync status changes across tabs", async () => {
      const channel = createFakeChannel("tab-A");
      subscriptionRegistry.initSync(channel, {
        dataSync: true,
        connectionDedup: false,
        heartbeatInterval: 3000,
        failoverTimeout: 10000,
      });

      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Status broadcast happens when connection transitions
      sub.capturedOnData!("data"); // triggers "live" status

      // Find the "live" status message (there may be "connecting" before it)
      const liveMsg = channel.messages.find((m) => m.type === "sub-status" && m.status === "live");
      expect(liveMsg).toBeDefined();
    });

    it("should deliver remote status to local observers", async () => {
      const channel = createFakeChannel("tab-B");
      subscriptionRegistry.initSync(channel, {
        dataSync: true,
        connectionDedup: false,
        heartbeatInterval: 3000,
        failoverTimeout: 10000,
      });

      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      subscriptionRegistry.handleSyncMessage({
        version: 1,
        type: "sub-status",
        tabId: "tab-A",
        key: "s:key1",
        status: "live",
        timestamp: Date.now(),
      });

      expect(observer.onStatusChange).toHaveBeenCalledWith("live");
    });

    it("should sync errors across tabs", async () => {
      const channel = createFakeChannel("tab-A");
      subscriptionRegistry.initSync(channel, {
        dataSync: true,
        connectionDedup: false,
        heartbeatInterval: 3000,
        failoverTimeout: 10000,
      });

      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      sub.capturedOnError!(new Error("ws error"));

      const errorMsg = channel.messages.find((m) => m.type === "sub-error");
      expect(errorMsg).toBeDefined();
    });

    it("should deliver remote error to local observers", async () => {
      const channel = createFakeChannel("tab-B");
      subscriptionRegistry.initSync(channel, {
        dataSync: true,
        connectionDedup: false,
        heartbeatInterval: 3000,
        failoverTimeout: 10000,
      });

      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      subscriptionRegistry.handleSyncMessage({
        version: 1,
        type: "sub-error",
        tabId: "tab-A",
        key: "s:key1",
        error: {
          type: "network",
          message: "remote error",
          retryCount: 0,
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      });

      expect(observer.onError).toHaveBeenCalledTimes(1);
      const err = observer.errorHistory[0]!;
      expect(err.message).toBe("remote error");
    });
  });

  // ─── Connection dedup mode ───

  describe("connection dedup mode", () => {
    it("should only start real connection when winning leadership", async () => {
      const channel = createFakeChannel("tab-A");
      subscriptionRegistry.initSync(channel, {
        dataSync: true,
        connectionDedup: true,
        heartbeatInterval: 3000,
        failoverTimeout: 10000,
      });

      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // subscriberFn should NOT be called yet (waiting for election)
      expect(sub.fn).toHaveBeenCalledTimes(0);

      // Win election (no competitors within claim window)
      await vi.advanceTimersByTimeAsync(100);

      // Now subscriberFn should be called
      expect(sub.fn).toHaveBeenCalledTimes(1);
    });

    it("should NOT start real connection when losing leadership (follower)", async () => {
      const channel = createFakeChannel("tab-B");
      subscriptionRegistry.initSync(channel, {
        dataSync: true,
        connectionDedup: true,
        heartbeatInterval: 3000,
        failoverTimeout: 10000,
      });

      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Simulate competitor with earlier timestamp
      subscriptionRegistry.handleSyncMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-A",
        key: "s:key1",
        timestamp: Date.now() - 1000,
      });

      await vi.advanceTimersByTimeAsync(100);

      // subscriberFn should NOT be called (follower)
      expect(sub.fn).toHaveBeenCalledTimes(0);
    });

    it("should receive data via BroadcastChannel as follower", async () => {
      const channel = createFakeChannel("tab-B");
      subscriptionRegistry.initSync(channel, {
        dataSync: true,
        connectionDedup: true,
        heartbeatInterval: 3000,
        failoverTimeout: 10000,
      });

      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Lose election
      subscriptionRegistry.handleSyncMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-A",
        key: "s:key1",
        timestamp: Date.now() - 1000,
      });
      await vi.advanceTimersByTimeAsync(100);

      // Receive data from leader tab-A
      subscriptionRegistry.handleSyncMessage({
        version: 1,
        type: "sub-data",
        tabId: "tab-A",
        key: "s:key1",
        data: { from: "leader" },
        timestamp: Date.now(),
      });

      expect(observer.onData).toHaveBeenCalledWith({ from: "leader" });
    });

    it("should failover: new leader starts connection when old leader dies", async () => {
      const channel = createFakeChannel("tab-B");
      subscriptionRegistry.initSync(channel, {
        dataSync: true,
        connectionDedup: true,
        heartbeatInterval: 1000,
        failoverTimeout: 3000,
      });

      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Lose initial election
      subscriptionRegistry.handleSyncMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-A",
        key: "s:key1",
        timestamp: Date.now() - 1000,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(sub.fn).toHaveBeenCalledTimes(0);

      // No heartbeat for failoverTimeout -> re-election
      await vi.advanceTimersByTimeAsync(3000);
      // Claim window
      await vi.advanceTimersByTimeAsync(100);

      // Now tab-B should have started connection (became leader)
      expect(sub.fn).toHaveBeenCalledTimes(1);
    });

    it("should resign leadership and stop connection on last observer detach", async () => {
      const channel = createFakeChannel("tab-A");
      subscriptionRegistry.initSync(channel, {
        dataSync: true,
        connectionDedup: true,
        heartbeatInterval: 3000,
        failoverTimeout: 10000,
      });

      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Win election
      await vi.advanceTimersByTimeAsync(100);
      expect(sub.fn).toHaveBeenCalledTimes(1);

      channel.messages.length = 0;

      // Detach last observer
      subscriptionRegistry.detach("s:key1", "obs-1");

      // Should have sent resign message
      const resignMsg = channel.messages.find((m) => m.type === "sub-leader-resign");
      expect(resignMsg).toBeDefined();

      // Connection should be closed
      expect(sub.unsubscribe).toHaveBeenCalled();
      expect(subscriptionRegistry._getConnectionCount()).toBe(0);
    });

    it("should start real connection on leader resign from another tab (failover)", async () => {
      const channel = createFakeChannel("tab-B");
      subscriptionRegistry.initSync(channel, {
        dataSync: true,
        connectionDedup: true,
        heartbeatInterval: 3000,
        failoverTimeout: 10000,
      });

      const observer = makeObserver("obs-1");
      const sub = makeSubscriberFn();

      subscriptionRegistry.attach("s:key1", "key1", observer, sub.fn, {
        maxRetries: 3,
        retryInterval: 1000,
      });

      // Lose initial election
      subscriptionRegistry.handleSyncMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-A",
        key: "s:key1",
        timestamp: Date.now() - 1000,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(sub.fn).toHaveBeenCalledTimes(0);

      // Leader resigns
      subscriptionRegistry.handleSyncMessage({
        version: 1,
        type: "sub-leader-resign",
        tabId: "tab-A",
        key: "s:key1",
        timestamp: Date.now(),
      });

      // Claim window
      await vi.advanceTimersByTimeAsync(100);

      // tab-B should now be leader and have started connection
      expect(sub.fn).toHaveBeenCalledTimes(1);
    });
  });
});
