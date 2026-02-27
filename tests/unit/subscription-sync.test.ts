import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SyncMessage, HashedKey } from "../../src/types/index.ts";
import type { SyncChannelApi } from "../../src/cache/sync-channel.ts";
import {
  createSubscriptionSync,
  type SubscriptionSyncConfig,
} from "../../src/subscription/subscription-sync.ts";

// ═══════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════

function createFakeChannel(tabId = "tab-A"): SyncChannelApi & {
  messages: SyncMessage[];
} {
  const messages: SyncMessage[] = [];
  return {
    tabId,
    messages,
    broadcast(msg: SyncMessage) {
      messages.push(msg);
    },
    close() {},
  };
}

const DEFAULT_CONFIG: SubscriptionSyncConfig = {
  dataSync: true,
  connectionDedup: true,
  heartbeatInterval: 3000,
  failoverTimeout: 10000,
};

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("createSubscriptionSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Data Sync ───

  describe("data sync", () => {
    it("should broadcast sub-data message via channel", () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      api.broadcastData("s:key1" as HashedKey, { value: 42 });

      expect(channel.messages).toHaveLength(1);
      const msg = channel.messages[0]!;
      expect(msg.type).toBe("sub-data");
      expect(msg.tabId).toBe("tab-A");
      if (msg.type === "sub-data") {
        expect(msg.key).toBe("s:key1");
        expect(msg.data).toEqual({ value: 42 });
      }

      api.cleanup();
    });

    it("should invoke onRemoteData when receiving sub-data from another tab", () => {
      const channel = createFakeChannel("tab-B");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      const onRemoteData = vi.fn();
      api.onRemoteData = onRemoteData;

      // Simulate receiving a message from tab-A
      api.handleMessage({
        version: 1,
        type: "sub-data",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        data: { value: 99 },
        timestamp: Date.now(),
      });

      expect(onRemoteData).toHaveBeenCalledWith("s:key1", { value: 99 });

      api.cleanup();
    });

    it("should NOT invoke onRemoteData for own tab messages (echo filtering)", () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      const onRemoteData = vi.fn();
      api.onRemoteData = onRemoteData;

      // Message from own tab
      api.handleMessage({
        version: 1,
        type: "sub-data",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        data: "own-data",
        timestamp: Date.now(),
      });

      expect(onRemoteData).not.toHaveBeenCalled();

      api.cleanup();
    });

    it("should broadcast sub-status message via channel", () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      api.broadcastStatus("s:key1" as HashedKey, "live");

      expect(channel.messages).toHaveLength(1);
      const msg = channel.messages[0]!;
      expect(msg.type).toBe("sub-status");
      if (msg.type === "sub-status") {
        expect(msg.key).toBe("s:key1");
        expect(msg.status).toBe("live");
      }

      api.cleanup();
    });

    it("should invoke onRemoteStatus when receiving sub-status from another tab", () => {
      const channel = createFakeChannel("tab-B");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      const onRemoteStatus = vi.fn();
      api.onRemoteStatus = onRemoteStatus;

      api.handleMessage({
        version: 1,
        type: "sub-status",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        status: "live",
        timestamp: Date.now(),
      });

      expect(onRemoteStatus).toHaveBeenCalledWith("s:key1", "live");

      api.cleanup();
    });

    it("should broadcast sub-error message via channel", () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      const error = {
        type: "network" as const,
        message: "connection lost",
        retryCount: 0,
        timestamp: Date.now(),
      };
      api.broadcastError("s:key1" as HashedKey, error);

      expect(channel.messages).toHaveLength(1);
      const msg = channel.messages[0]!;
      expect(msg.type).toBe("sub-error");
      if (msg.type === "sub-error") {
        expect(msg.key).toBe("s:key1");
        expect(msg.error.message).toBe("connection lost");
      }

      api.cleanup();
    });

    it("should invoke onRemoteError when receiving sub-error from another tab", () => {
      const channel = createFakeChannel("tab-B");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      const onRemoteError = vi.fn();
      api.onRemoteError = onRemoteError;

      api.handleMessage({
        version: 1,
        type: "sub-error",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        error: {
          type: "network",
          message: "fail",
          retryCount: 0,
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      });

      expect(onRemoteError).toHaveBeenCalledTimes(1);
      expect(onRemoteError.mock.calls[0]![0]).toBe("s:key1");
      expect(onRemoteError.mock.calls[0]![1].message).toBe("fail");

      api.cleanup();
    });

    it("should not invoke callbacks when dataSync is disabled", () => {
      const channel = createFakeChannel("tab-B");
      const api = createSubscriptionSync(channel, {
        ...DEFAULT_CONFIG,
        dataSync: false,
      });

      const onRemoteData = vi.fn();
      api.onRemoteData = onRemoteData;

      api.handleMessage({
        version: 1,
        type: "sub-data",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        data: "ignored",
        timestamp: Date.now(),
      });

      expect(onRemoteData).not.toHaveBeenCalled();

      api.cleanup();
    });
  });

  // ─── Leader Election ───

  describe("leader election", () => {
    it("should win leadership when no competitor claims within window", async () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      const promise = api.claimLeadership("s:key1" as HashedKey);

      // Advance past claim window (100ms)
      await vi.advanceTimersByTimeAsync(100);

      const result = await promise;
      expect(result).toBe(true);
      expect(api.isLeader("s:key1" as HashedKey)).toBe(true);

      // Should have broadcast a claim message
      const claimMsg = channel.messages.find((m) => m.type === "sub-leader-claim");
      expect(claimMsg).toBeDefined();

      api.cleanup();
    });

    it("should lose leadership when a competing claim has earlier timestamp", async () => {
      const channel = createFakeChannel("tab-B");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      const now = Date.now();
      const promise = api.claimLeadership("s:key1" as HashedKey);

      // Simulate a competing claim from tab-A with earlier timestamp
      api.handleMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        timestamp: now - 10, // Earlier than ours
      });

      await vi.advanceTimersByTimeAsync(100);

      const result = await promise;
      expect(result).toBe(false);
      expect(api.isLeader("s:key1" as HashedKey)).toBe(false);

      api.cleanup();
    });

    it("should win leadership via tiebreak when timestamps match (smaller tabId wins)", async () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      const promise = api.claimLeadership("s:key1" as HashedKey);

      // Get the claim timestamp from the sent message
      const claimMsg = channel.messages.find((m) => m.type === "sub-leader-claim");
      const claimTs = claimMsg!.timestamp;

      // Competing claim with same timestamp but larger tabId
      api.handleMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-Z",
        key: "s:key1" as HashedKey,
        timestamp: claimTs, // Same timestamp
      });

      await vi.advanceTimersByTimeAsync(100);

      const result = await promise;
      // tab-A < tab-Z lexicographically, so tab-A wins
      expect(result).toBe(true);
      expect(api.isLeader("s:key1" as HashedKey)).toBe(true);

      api.cleanup();
    });

    it("should lose leadership via tiebreak when tabId is larger", async () => {
      const channel = createFakeChannel("tab-Z");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      const promise = api.claimLeadership("s:key1" as HashedKey);

      const claimMsg = channel.messages.find((m) => m.type === "sub-leader-claim");
      const claimTs = claimMsg!.timestamp;

      // Competing claim with same timestamp but smaller tabId
      api.handleMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        timestamp: claimTs,
      });

      await vi.advanceTimersByTimeAsync(100);

      const result = await promise;
      // tab-Z > tab-A lexicographically, so tab-Z loses
      expect(result).toBe(false);

      api.cleanup();
    });

    it("should send heartbeat at configured interval when leader", async () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, {
        ...DEFAULT_CONFIG,
        heartbeatInterval: 1000,
      });

      const promise = api.claimLeadership("s:key1" as HashedKey);
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // Clear messages from claim
      channel.messages.length = 0;

      // Advance past one heartbeat interval
      await vi.advanceTimersByTimeAsync(1000);

      const heartbeats = channel.messages.filter((m) => m.type === "sub-leader-heartbeat");
      expect(heartbeats).toHaveLength(1);
      if (heartbeats[0]!.type === "sub-leader-heartbeat") {
        expect(heartbeats[0]!.key).toBe("s:key1");
      }

      // Advance again
      await vi.advanceTimersByTimeAsync(1000);
      const allHeartbeats = channel.messages.filter((m) => m.type === "sub-leader-heartbeat");
      expect(allHeartbeats).toHaveLength(2);

      api.cleanup();
    });

    it("should invoke onLeaderChanged(true) when becoming leader", async () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      const onLeaderChanged = vi.fn();
      api.onLeaderChanged = onLeaderChanged;

      const promise = api.claimLeadership("s:key1" as HashedKey);
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(onLeaderChanged).toHaveBeenCalledWith("s:key1", true);

      api.cleanup();
    });

    it("should invoke onLeaderChanged(false) when losing election", async () => {
      const channel = createFakeChannel("tab-B");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      const onLeaderChanged = vi.fn();
      api.onLeaderChanged = onLeaderChanged;

      const promise = api.claimLeadership("s:key1" as HashedKey);

      api.handleMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        timestamp: Date.now() - 100,
      });

      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(onLeaderChanged).toHaveBeenCalledWith("s:key1", false);

      api.cleanup();
    });

    it("should re-elect on heartbeat timeout (failover)", async () => {
      const channel = createFakeChannel("tab-B");
      const api = createSubscriptionSync(channel, {
        ...DEFAULT_CONFIG,
        heartbeatInterval: 1000,
        failoverTimeout: 3000,
      });

      const onLeaderChanged = vi.fn();
      api.onLeaderChanged = onLeaderChanged;

      // Lose initial election
      const promise = api.claimLeadership("s:key1" as HashedKey);
      api.handleMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        timestamp: Date.now() - 100,
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;
      expect(api.isLeader("s:key1" as HashedKey)).toBe(false);
      onLeaderChanged.mockClear();

      // No heartbeat arrives within failoverTimeout
      await vi.advanceTimersByTimeAsync(3000);

      // After failover timeout, a re-election should trigger
      // (the tab should attempt to claim leadership again)
      // Wait for the new claim window
      await vi.advanceTimersByTimeAsync(100);

      expect(onLeaderChanged).toHaveBeenCalledWith("s:key1", true);
      expect(api.isLeader("s:key1" as HashedKey)).toBe(true);

      api.cleanup();
    });

    it("should reset failover timer on heartbeat receipt", async () => {
      const channel = createFakeChannel("tab-B");
      const api = createSubscriptionSync(channel, {
        ...DEFAULT_CONFIG,
        heartbeatInterval: 1000,
        failoverTimeout: 3000,
      });

      const onLeaderChanged = vi.fn();
      api.onLeaderChanged = onLeaderChanged;

      // Lose initial election
      const promise = api.claimLeadership("s:key1" as HashedKey);
      api.handleMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        timestamp: Date.now() - 100,
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;
      onLeaderChanged.mockClear();

      // Heartbeat at 2s (before 3s failover)
      await vi.advanceTimersByTimeAsync(2000);
      api.handleMessage({
        version: 1,
        type: "sub-leader-heartbeat",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        timestamp: Date.now(),
      });

      // Advance 2s more (total 4s from start but only 2s from last heartbeat)
      await vi.advanceTimersByTimeAsync(2000);

      // Should NOT have triggered failover yet
      expect(api.isLeader("s:key1" as HashedKey)).toBe(false);
      expect(onLeaderChanged).not.toHaveBeenCalled();

      api.cleanup();
    });

    it("should broadcast sub-leader-resign on resignLeadership", async () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      const promise = api.claimLeadership("s:key1" as HashedKey);
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      channel.messages.length = 0;

      api.resignLeadership("s:key1" as HashedKey);

      const resignMsg = channel.messages.find((m) => m.type === "sub-leader-resign");
      expect(resignMsg).toBeDefined();
      expect(api.isLeader("s:key1" as HashedKey)).toBe(false);

      api.cleanup();
    });

    it("should re-elect immediately when sub-leader-resign received", async () => {
      const channel = createFakeChannel("tab-B");
      const api = createSubscriptionSync(channel, {
        ...DEFAULT_CONFIG,
        failoverTimeout: 10000,
      });

      const onLeaderChanged = vi.fn();
      api.onLeaderChanged = onLeaderChanged;

      // Lose initial election
      const promise = api.claimLeadership("s:key1" as HashedKey);
      api.handleMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        timestamp: Date.now() - 100,
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;
      onLeaderChanged.mockClear();

      // Receive resign from leader
      api.handleMessage({
        version: 1,
        type: "sub-leader-resign",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        timestamp: Date.now(),
      });

      // Wait for claim window
      await vi.advanceTimersByTimeAsync(100);

      expect(onLeaderChanged).toHaveBeenCalledWith("s:key1", true);
      expect(api.isLeader("s:key1" as HashedKey)).toBe(true);

      api.cleanup();
    });

    it("should deduplicate claims from the same tabId", async () => {
      const channel = createFakeChannel("tab-B");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      const onLeaderChanged = vi.fn();
      api.onLeaderChanged = onLeaderChanged;

      const promise = api.claimLeadership("s:key1" as HashedKey);

      // Same tab sends multiple claims (e.g. due to rapid reconnects)
      const now = Date.now();
      api.handleMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        timestamp: now - 50,
      });
      api.handleMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        timestamp: now - 30, // second claim from same tab
      });

      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      // tab-A should only count once in the election regardless of how many claims sent
      // Since tab-A has earlier timestamp, tab-A wins and tab-B loses
      expect(result).toBe(false);

      api.cleanup();
    });

    it("should not start election when connectionDedup is disabled", async () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, {
        ...DEFAULT_CONFIG,
        connectionDedup: false,
      });

      const promise = api.claimLeadership("s:key1" as HashedKey);
      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      // When dedup is disabled, claimLeadership always returns true (local-only)
      expect(result).toBe(true);
      // But no claim message should be broadcast
      const claimMsgs = channel.messages.filter((m) => m.type === "sub-leader-claim");
      expect(claimMsgs).toHaveLength(0);

      api.cleanup();
    });

    it("should return false for isLeader on unknown key", () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      expect(api.isLeader("s:unknown" as HashedKey)).toBe(false);

      api.cleanup();
    });

    it("should handle independent per-key leader states", async () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      // Claim leadership for key1
      const p1 = api.claimLeadership("s:key1" as HashedKey);
      await vi.advanceTimersByTimeAsync(100);
      await p1;

      // Claim leadership for key2 but lose
      const p2 = api.claimLeadership("s:key2" as HashedKey);
      api.handleMessage({
        version: 1,
        type: "sub-leader-claim",
        tabId: "tab-0", // "tab-0" < "tab-A" lexicographically
        key: "s:key2" as HashedKey,
        timestamp: Date.now() - 100,
      });
      await vi.advanceTimersByTimeAsync(100);
      await p2;

      expect(api.isLeader("s:key1" as HashedKey)).toBe(true);
      expect(api.isLeader("s:key2" as HashedKey)).toBe(false);

      api.cleanup();
    });
  });

  // ─── Cleanup ───

  describe("cleanup", () => {
    it("should stop all timers on cleanup", async () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, {
        ...DEFAULT_CONFIG,
        heartbeatInterval: 1000,
      });

      // Become leader (starts heartbeat timer)
      const promise = api.claimLeadership("s:key1" as HashedKey);
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      channel.messages.length = 0;

      api.cleanup();

      // cleanup() sends leader-resign broadcasts, so clear those first
      channel.messages.length = 0;

      // Advance time - no more heartbeats should be sent
      await vi.advanceTimersByTimeAsync(5000);
      expect(channel.messages).toHaveLength(0);
    });

    it("should clean up a single key with cleanupKey", async () => {
      const channel = createFakeChannel("tab-A");
      const api = createSubscriptionSync(channel, {
        ...DEFAULT_CONFIG,
        heartbeatInterval: 1000,
      });

      // Become leader for key1 and key2
      const p1 = api.claimLeadership("s:key1" as HashedKey);
      await vi.advanceTimersByTimeAsync(100);
      await p1;

      const p2 = api.claimLeadership("s:key2" as HashedKey);
      await vi.advanceTimersByTimeAsync(100);
      await p2;

      // Cleanup only key1
      api.cleanupKey("s:key1" as HashedKey);

      expect(api.isLeader("s:key1" as HashedKey)).toBe(false);
      expect(api.isLeader("s:key2" as HashedKey)).toBe(true);

      channel.messages.length = 0;

      // Heartbeats should only come for key2
      await vi.advanceTimersByTimeAsync(1000);
      const heartbeats = channel.messages.filter((m) => m.type === "sub-leader-heartbeat");
      expect(heartbeats).toHaveLength(1);
      if (heartbeats[0]!.type === "sub-leader-heartbeat") {
        expect(heartbeats[0]!.key).toBe("s:key2");
      }

      api.cleanup();
    });
  });

  // ─── Ignore non-sub messages ───

  describe("message filtering", () => {
    it("should ignore non-sub messages", () => {
      const channel = createFakeChannel("tab-B");
      const api = createSubscriptionSync(channel, DEFAULT_CONFIG);

      // Should not throw when receiving cache sync messages
      api.handleMessage({
        version: 1,
        type: "set",
        tabId: "tab-A",
        key: "s:key1" as HashedKey,
        entry: { data: 1, timestamp: Date.now() },
        timestamp: Date.now(),
      });

      api.cleanup();
    });
  });
});
