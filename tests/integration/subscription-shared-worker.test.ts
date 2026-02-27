import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HashedKey, SWRError, SubscriptionStatus } from "../../src/types/index.ts";
import type { SubscriptionSyncApi } from "../../src/subscription/subscription-sync.ts";
import {
  subscriptionRegistry,
  type SubscriptionObserver,
} from "../../src/subscription/subscription-registry.ts";

// ═══════════════════════════════════════════════════════════════
// Fake SharedWorker infrastructure (same as unit test but
// allows creating multiple independent "tab" APIs)
// ═══════════════════════════════════════════════════════════════

class FakeMessagePort {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  private _closed = false;

  postMessage(_data: unknown): void {
    // overridden by createFakePortPair
  }

  close(): void {
    this._closed = true;
    this.onmessage = null;
  }

  get closed(): boolean {
    return this._closed;
  }
}

function createFakePortPair(): { clientPort: FakeMessagePort; workerPort: FakeMessagePort } {
  const clientPort = new FakeMessagePort();
  const workerPort = new FakeMessagePort();

  // Synchronous delivery for testing (no microtask delay)
  clientPort.postMessage = (data: unknown) => {
    if (clientPort.closed) return;
    workerPort.onmessage?.({ data });
  };

  workerPort.postMessage = (data: unknown) => {
    if (workerPort.closed) return;
    clientPort.onmessage?.({ data });
  };

  return { clientPort, workerPort };
}

class FakeWorkerCoordinator {
  private ports = new Set<FakeMessagePort>();
  private portHeartbeats = new Map<FakeMessagePort, number>();
  private keyState = new Map<
    string,
    { leader: FakeMessagePort | null; subscribers: Set<FakeMessagePort> }
  >();

  addPort(port: FakeMessagePort): void {
    this.ports.add(port);
    this.portHeartbeats.set(port, Date.now());

    port.onmessage = (ev: { data: unknown }) => {
      this.handleMessage(port, ev.data as Record<string, unknown>);
    };
  }

  private handleMessage(port: FakeMessagePort, msg: Record<string, unknown>): void {
    const type = msg.type as string;
    if (!type) return;

    switch (type) {
      case "register":
        if (typeof msg.key === "string") this.registerSubscriber(port, msg.key);
        break;
      case "unregister":
        if (typeof msg.key === "string") this.unregisterSubscriber(port, msg.key);
        break;
      case "disconnect":
        this.disconnectPort(port);
        break;
      case "heartbeat":
        this.portHeartbeats.set(port, Date.now());
        break;
      case "sub-data":
      case "sub-status":
      case "sub-error":
        if (typeof msg.key === "string") this.relayToSubscribers(port, msg.key, msg);
        break;
    }
  }

  private registerSubscriber(port: FakeMessagePort, key: string): void {
    let state = this.keyState.get(key);
    if (!state) {
      state = { leader: null, subscribers: new Set() };
      this.keyState.set(key, state);
    }
    state.subscribers.add(port);
    if (!state.leader) {
      state.leader = port;
      port.postMessage({ type: "leader-changed", key, isLeader: true });
    } else {
      port.postMessage({ type: "leader-changed", key, isLeader: false });
    }
  }

  private unregisterSubscriber(port: FakeMessagePort, key: string): void {
    const state = this.keyState.get(key);
    if (!state) return;
    state.subscribers.delete(port);
    if (state.leader === port) {
      state.leader = null;
      this.reassignLeader(key, state);
    }
    if (state.subscribers.size === 0) this.keyState.delete(key);
  }

  private disconnectPort(port: FakeMessagePort): void {
    this.ports.delete(port);
    this.portHeartbeats.delete(port);
    for (const [key, state] of this.keyState) {
      if (state.subscribers.has(port)) {
        state.subscribers.delete(port);
        if (state.leader === port) {
          state.leader = null;
          this.reassignLeader(key, state);
        }
        if (state.subscribers.size === 0) this.keyState.delete(key);
      }
    }
  }

  private reassignLeader(
    key: string,
    state: { leader: FakeMessagePort | null; subscribers: Set<FakeMessagePort> },
  ): void {
    if (state.subscribers.size === 0) return;
    const newLeader = state.subscribers.values().next().value!;
    state.leader = newLeader;
    newLeader.postMessage({ type: "leader-changed", key, isLeader: true });
  }

  private relayToSubscribers(
    sender: FakeMessagePort,
    key: string,
    msg: Record<string, unknown>,
  ): void {
    const state = this.keyState.get(key);
    if (!state || state.leader !== sender) return;
    for (const port of state.subscribers) {
      if (port !== sender) port.postMessage(msg);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Helper: create a SharedWorker-based SubscriptionSyncApi that
// connects to the given coordinator (simulating one "tab")
// ═══════════════════════════════════════════════════════════════

function createFakeSyncApi(
  coordinator: FakeWorkerCoordinator,
  config: { dataSync: boolean; connectionDedup: boolean },
): SubscriptionSyncApi {
  const { clientPort, workerPort } = createFakePortPair();
  coordinator.addPort(workerPort);

  const pendingClaims = new Map<HashedKey, (won: boolean) => void>();
  const leaderState = new Map<HashedKey, boolean>();

  clientPort.onmessage = (ev: { data: unknown }) => {
    const msg = ev.data as Record<string, unknown>;
    if (!msg || typeof msg !== "object" || !msg.type) return;

    switch (msg.type) {
      case "leader-changed": {
        const key = msg.key as HashedKey;
        const isLeader = msg.isLeader as boolean;
        leaderState.set(key, isLeader);
        const resolve = pendingClaims.get(key);
        if (resolve) {
          pendingClaims.delete(key);
          resolve(isLeader);
        }
        api.onLeaderChanged?.(key, isLeader);
        break;
      }
      case "sub-data":
        if (config.dataSync) api.onRemoteData?.(msg.key as HashedKey, msg.data);
        break;
      case "sub-status":
        if (config.dataSync)
          api.onRemoteStatus?.(msg.key as HashedKey, msg.status as SubscriptionStatus);
        break;
      case "sub-error":
        if (config.dataSync) api.onRemoteError?.(msg.key as HashedKey, msg.error as SWRError);
        break;
    }
  };

  const api: SubscriptionSyncApi = {
    onRemoteData: null,
    onRemoteStatus: null,
    onRemoteError: null,
    onLeaderChanged: null,

    broadcastData(key, data) {
      clientPort.postMessage({ type: "sub-data", key, data });
    },
    broadcastStatus(key, status) {
      clientPort.postMessage({ type: "sub-status", key, status });
    },
    broadcastError(key, error) {
      clientPort.postMessage({ type: "sub-error", key, error });
    },
    claimLeadership(key) {
      if (!config.connectionDedup) {
        leaderState.set(key, true);
        api.onLeaderChanged?.(key, true);
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        pendingClaims.set(key, resolve);
        clientPort.postMessage({ type: "register", key });
      });
    },
    resignLeadership(key) {
      leaderState.set(key, false);
      clientPort.postMessage({ type: "unregister", key });
    },
    isLeader(key) {
      return leaderState.get(key) ?? false;
    },
    handleMessage() {},
    cleanup() {
      clientPort.postMessage({ type: "disconnect" });
      for (const [, resolve] of pendingClaims) resolve(false);
      pendingClaims.clear();
      leaderState.clear();
      clientPort.close();
    },
    cleanupKey(key) {
      leaderState.delete(key);
      clientPort.postMessage({ type: "unregister", key });
      const resolve = pendingClaims.get(key);
      if (resolve) {
        pendingClaims.delete(key);
        resolve(false);
      }
    },
  };

  return api;
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

// ═══════════════════════════════════════════════════════════════
// Microtask flush helper
// ═══════════════════════════════════════════════════════════════

/**
 * Flush multiple rounds of microtasks.
 * FakeMessagePort uses queueMicrotask, so a single message hop
 * requires 2 microtask rounds (send -> receive -> send -> receive).
 */
async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("Subscription SharedWorker integration", () => {
  let coordinator: FakeWorkerCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    coordinator = new FakeWorkerCoordinator();
    subscriptionRegistry._reset();
  });

  afterEach(() => {
    subscriptionRegistry._reset();
    vi.useRealTimers();
  });

  it("Tab A subscribe -> leader -> data -> Tab B (follower) receives via SharedWorker relay", async () => {
    // Tab A: uses the real singleton registry with SharedWorker sync
    const tabAApi = createFakeSyncApi(coordinator, {
      dataSync: true,
      connectionDedup: true,
    });
    subscriptionRegistry.initSyncDirect(tabAApi, {
      dataSync: true,
      connectionDedup: true,
      heartbeatInterval: 5000,
      failoverTimeout: 15000,
    });

    const observerA = makeObserver("obs-A");
    const subA = makeSubscriberFn();
    subscriptionRegistry.attach("s:price", "price", observerA, subA.fn, {
      maxRetries: 3,
      retryInterval: 1000,
    });

    // Allow microtasks for register -> leader-changed -> handleLeaderChanged
    await flushMicrotasks();

    // Tab A should be leader and started connection
    expect(subA.fn).toHaveBeenCalledTimes(1);

    // Tab B: separate sync API connected to same coordinator
    const tabBApi = createFakeSyncApi(coordinator, {
      dataSync: true,
      connectionDedup: true,
    });
    const tabBData: unknown[] = [];
    tabBApi.onRemoteData = (_key, data) => {
      tabBData.push(data);
    };

    // Tab B registers for same key
    const tabBResult = await tabBApi.claimLeadership("s:price" as HashedKey);

    // Tab B should be follower
    expect(tabBResult).toBe(false);
    expect(tabBApi.isLeader("s:price" as HashedKey)).toBe(false);

    // Tab A receives data from WebSocket -> broadcasts via SharedWorker
    subA.capturedOnData!({ price: 150 });
    await flushMicrotasks();

    // Tab B should have received the data via relay
    expect(tabBData).toContainEqual({ price: 150 });

    tabAApi.cleanup();
    tabBApi.cleanup();
  });

  it("Tab A disconnect -> Tab B promoted to leader -> starts connection", async () => {
    // Tab A setup
    const tabAApi = createFakeSyncApi(coordinator, {
      dataSync: true,
      connectionDedup: true,
    });
    subscriptionRegistry.initSyncDirect(tabAApi, {
      dataSync: true,
      connectionDedup: true,
      heartbeatInterval: 5000,
      failoverTimeout: 15000,
    });

    const observerA = makeObserver("obs-A");
    const subA = makeSubscriberFn();
    subscriptionRegistry.attach("s:key1", "key1", observerA, subA.fn, {
      maxRetries: 3,
      retryInterval: 1000,
    });

    await flushMicrotasks();
    expect(subA.fn).toHaveBeenCalledTimes(1);

    // Tab B setup (separate API, simulating a different tab)
    const tabBApi = createFakeSyncApi(coordinator, {
      dataSync: true,
      connectionDedup: true,
    });
    const tabBLeaderChanges: Array<{ key: string; isLeader: boolean }> = [];
    tabBApi.onLeaderChanged = (key, isLeader) => {
      tabBLeaderChanges.push({ key, isLeader });
    };

    await tabBApi.claimLeadership("s:key1" as HashedKey);
    expect(tabBApi.isLeader("s:key1" as HashedKey)).toBe(false);

    // Tab A disconnects (simulating tab close)
    // We resign from registry first, then cleanup the API
    subscriptionRegistry.detach("s:key1", "obs-A");
    await flushMicrotasks();

    // Tab B should now be promoted to leader
    expect(tabBApi.isLeader("s:key1" as HashedKey)).toBe(true);
    expect(tabBLeaderChanges).toContainEqual({ key: "s:key1", isLeader: true });

    tabBApi.cleanup();
  });

  it("3 tabs: Tab A resign -> Tab B becomes leader -> Tab C remains follower", async () => {
    // Tab A
    const tabAApi = createFakeSyncApi(coordinator, {
      dataSync: true,
      connectionDedup: true,
    });
    subscriptionRegistry.initSyncDirect(tabAApi, {
      dataSync: true,
      connectionDedup: true,
      heartbeatInterval: 5000,
      failoverTimeout: 15000,
    });

    const observerA = makeObserver("obs-A");
    const subA = makeSubscriberFn();
    subscriptionRegistry.attach("s:stream", "stream", observerA, subA.fn, {
      maxRetries: 3,
      retryInterval: 1000,
    });

    await flushMicrotasks();
    expect(subA.fn).toHaveBeenCalledTimes(1); // Tab A is leader

    // Tab B
    const tabBApi = createFakeSyncApi(coordinator, {
      dataSync: true,
      connectionDedup: true,
    });
    const tabBLeaderChanges: boolean[] = [];
    tabBApi.onLeaderChanged = (_key, isLeader) => {
      tabBLeaderChanges.push(isLeader);
    };
    await tabBApi.claimLeadership("s:stream" as HashedKey);
    expect(tabBApi.isLeader("s:stream" as HashedKey)).toBe(false);

    // Tab C
    const tabCApi = createFakeSyncApi(coordinator, {
      dataSync: true,
      connectionDedup: true,
    });
    const tabCLeaderChanges: boolean[] = [];
    tabCApi.onLeaderChanged = (_key, isLeader) => {
      tabCLeaderChanges.push(isLeader);
    };
    await tabCApi.claimLeadership("s:stream" as HashedKey);
    expect(tabCApi.isLeader("s:stream" as HashedKey)).toBe(false);

    // Tab A resigns
    subscriptionRegistry.detach("s:stream", "obs-A");
    await flushMicrotasks();

    // Tab B should be the new leader (first in subscriber set)
    expect(tabBApi.isLeader("s:stream" as HashedKey)).toBe(true);
    expect(tabBLeaderChanges).toContain(true);

    // Tab C should remain follower
    expect(tabCApi.isLeader("s:stream" as HashedKey)).toBe(false);

    tabBApi.cleanup();
    tabCApi.cleanup();
  });

  it("data and status relay work end-to-end with 2 tabs", async () => {
    // Tab A: leader
    const tabAApi = createFakeSyncApi(coordinator, {
      dataSync: true,
      connectionDedup: true,
    });
    subscriptionRegistry.initSyncDirect(tabAApi, {
      dataSync: true,
      connectionDedup: true,
      heartbeatInterval: 5000,
      failoverTimeout: 15000,
    });

    const observerA = makeObserver("obs-A");
    const subA = makeSubscriberFn();
    subscriptionRegistry.attach("s:events", "events", observerA, subA.fn, {
      maxRetries: 3,
      retryInterval: 1000,
    });
    await flushMicrotasks();

    // Tab B: follower
    const tabBApi = createFakeSyncApi(coordinator, {
      dataSync: true,
      connectionDedup: true,
    });
    const tabBStatuses: SubscriptionStatus[] = [];
    const tabBData: unknown[] = [];
    tabBApi.onRemoteData = (_key, data) => tabBData.push(data);
    tabBApi.onRemoteStatus = (_key, status) => tabBStatuses.push(status);
    await tabBApi.claimLeadership("s:events" as HashedKey);

    // Tab A receives data -> triggers "live" status + data broadcast
    subA.capturedOnData!({ event: "click", id: 1 });
    await flushMicrotasks();

    // Tab B should receive both status and data
    expect(tabBStatuses).toContain("live");
    expect(tabBData).toContainEqual({ event: "click", id: 1 });

    // Send more data
    subA.capturedOnData!({ event: "scroll", id: 2 });
    await flushMicrotasks();

    expect(tabBData).toContainEqual({ event: "scroll", id: 2 });

    tabAApi.cleanup();
    tabBApi.cleanup();
  });
});
