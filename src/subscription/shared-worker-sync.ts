import type { HashedKey, SubscriptionStatus, SWRError } from "../types/index.ts";
import { serializeSWRError } from "../utils/error.ts";
import type { SubscriptionSyncApi, SubscriptionSyncConfig } from "./subscription-sync.ts";
import type { SyncMessage } from "../types/index.ts";

// ═══════════════════════════════════════════════════════════════
// SharedWorker coordinator code (inlined as a string)
// ═══════════════════════════════════════════════════════════════

const WORKER_CODE = /* js */ `
"use strict";

const ports = new Set();
const portHeartbeats = new Map();
// keyState: Map<key, { leader: MessagePort | null, subscribers: Set<MessagePort> }>
const keyState = new Map();

// Prune dead ports every 10s (heartbeat timeout: 15s)
setInterval(() => {
  const now = Date.now();
  const DEAD_TIMEOUT = 15000;
  for (const [port, lastHb] of portHeartbeats) {
    if (now - lastHb > DEAD_TIMEOUT) {
      disconnectPort(port);
    }
  }
}, 10000);

self.onconnect = function(e) {
  const port = e.ports[0];
  ports.add(port);
  portHeartbeats.set(port, Date.now());

  port.onmessage = function(ev) {
    handleMessage(port, ev.data);
  };
};

function handleMessage(port, msg) {
  if (!msg || typeof msg !== "object" || !msg.type) return;

  switch (msg.type) {
    case "register":
      if (typeof msg.key === "string") registerSubscriber(port, msg.key);
      break;
    case "unregister":
      if (typeof msg.key === "string") unregisterSubscriber(port, msg.key);
      break;
    case "disconnect":
      disconnectPort(port);
      break;
    case "heartbeat":
      portHeartbeats.set(port, Date.now());
      break;
    case "sub-data":
    case "sub-status":
    case "sub-error":
      if (typeof msg.key === "string") relayToSubscribers(port, msg.key, msg);
      break;
  }
}

function registerSubscriber(port, key) {
  let state = keyState.get(key);
  if (!state) {
    state = { leader: null, subscribers: new Set() };
    keyState.set(key, state);
  }

  state.subscribers.add(port);

  if (!state.leader) {
    state.leader = port;
    port.postMessage({ type: "leader-changed", key: key, isLeader: true });
  } else {
    port.postMessage({ type: "leader-changed", key: key, isLeader: false });
  }
}

function unregisterSubscriber(port, key) {
  const state = keyState.get(key);
  if (!state) return;

  state.subscribers.delete(port);

  if (state.leader === port) {
    state.leader = null;
    reassignLeader(key, state);
  }

  if (state.subscribers.size === 0) {
    keyState.delete(key);
  }
}

function disconnectPort(port) {
  ports.delete(port);
  portHeartbeats.delete(port);

  for (const [key, state] of keyState) {
    if (state.subscribers.has(port)) {
      state.subscribers.delete(port);

      if (state.leader === port) {
        state.leader = null;
        reassignLeader(key, state);
      }

      if (state.subscribers.size === 0) {
        keyState.delete(key);
      }
    }
  }
}

function reassignLeader(key, state) {
  if (state.subscribers.size === 0) return;
  const newLeader = state.subscribers.values().next().value;
  state.leader = newLeader;
  newLeader.postMessage({ type: "leader-changed", key: key, isLeader: true });
}

function relayToSubscribers(sender, key, msg) {
  const state = keyState.get(key);
  if (!state) return;
  // Only relay from leader
  if (state.leader !== sender) return;

  for (const port of state.subscribers) {
    if (port !== sender) {
      port.postMessage(msg);
    }
  }
}
`;

// ═══════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════

/**
 * Create a SharedWorker-based SubscriptionSyncApi.
 *
 * Returns null if SharedWorker is unavailable (Safari) or creation fails (CSP).
 * The caller should fall back to BroadcastChannel-based sync in that case.
 */
export function createSharedWorkerSync(
  config: SubscriptionSyncConfig,
  channelName?: string,
  workerUrl?: string,
): SubscriptionSyncApi | null {
  if (typeof SharedWorker === "undefined") {
    return null;
  }

  let worker: SharedWorker;
  let blobUrlToRevoke: string | null = null;
  try {
    let url: string;
    if (workerUrl) {
      url = workerUrl;
    } else {
      const blobUrl = createBlobUrl();
      if (!blobUrl) return null;
      url = blobUrl;
      blobUrlToRevoke = blobUrl;
    }
    const name = channelName ? `qwik-swr-sub-${channelName}` : "qwik-swr-sub";
    worker = new SharedWorker(url, name);
  } catch {
    // CSP or other error
    if (blobUrlToRevoke) URL.revokeObjectURL(blobUrlToRevoke);
    return null;
  }

  const port = worker.port;

  // Internal state
  const pendingClaims = new Map<HashedKey, (won: boolean) => void>();
  const leaderState = new Map<HashedKey, boolean>();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ─── Port message handler ───

  port.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object" || !msg.type) return;

    switch (msg.type) {
      case "leader-changed": {
        const key = msg.key as HashedKey;
        const isLeader = msg.isLeader as boolean;
        leaderState.set(key, isLeader);

        // Resolve pending claim if any
        const resolve = pendingClaims.get(key);
        if (resolve) {
          pendingClaims.delete(key);
          resolve(isLeader);
        }

        api.onLeaderChanged?.(key, isLeader);
        break;
      }
      case "sub-data": {
        if (!config.dataSync) return;
        api.onRemoteData?.(msg.key as HashedKey, msg.data);
        break;
      }
      case "sub-status": {
        if (!config.dataSync) return;
        api.onRemoteStatus?.(msg.key as HashedKey, msg.status as SubscriptionStatus);
        break;
      }
      case "sub-error": {
        if (!config.dataSync) return;
        api.onRemoteError?.(msg.key as HashedKey, msg.error as SWRError);
        break;
      }
    }
  };

  // ─── Heartbeat ───

  heartbeatTimer = setInterval(() => {
    port.postMessage({ type: "heartbeat" });
  }, config.heartbeatInterval);

  // ─── beforeunload ───

  let unloadHandler: (() => void) | null = null;
  if (typeof globalThis !== "undefined" && typeof globalThis.addEventListener === "function") {
    unloadHandler = () => {
      port.postMessage({ type: "disconnect" });
    };
    globalThis.addEventListener("beforeunload", unloadHandler);
  }

  // ─── API ───

  const api: SubscriptionSyncApi = {
    onRemoteData: null,
    onRemoteStatus: null,
    onRemoteError: null,
    onLeaderChanged: null,

    broadcastData(key: HashedKey, data: unknown): void {
      port.postMessage({ type: "sub-data", key, data });
    },

    broadcastStatus(key: HashedKey, status: SubscriptionStatus): void {
      port.postMessage({ type: "sub-status", key, status });
    },

    broadcastError(key: HashedKey, error: SWRError): void {
      port.postMessage({ type: "sub-error", key, error: serializeSWRError(error) });
    },

    claimLeadership(key: HashedKey): Promise<boolean> {
      if (!config.connectionDedup) {
        // No dedup: always "win" locally
        leaderState.set(key, true);
        api.onLeaderChanged?.(key, true);
        return Promise.resolve(true);
      }

      // Timeout to prevent indefinite hang if worker is unresponsive (MF-13)
      const CLAIM_TIMEOUT_MS = 5000;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pendingClaims.delete(key);
          // Assume leader if worker doesn't respond
          leaderState.set(key, true);
          api.onLeaderChanged?.(key, true);
          resolve(true);
        }, CLAIM_TIMEOUT_MS);

        pendingClaims.set(key, (won: boolean) => {
          clearTimeout(timer);
          resolve(won);
        });
        port.postMessage({ type: "register", key });
      });
    },

    resignLeadership(key: HashedKey): void {
      leaderState.set(key, false);
      port.postMessage({ type: "unregister", key });
    },

    isLeader(key: HashedKey): boolean {
      return leaderState.get(key) ?? false;
    },

    // No-op: SharedWorker does not use BroadcastChannel messages
    handleMessage(_msg: SyncMessage): void {},

    cleanup(): void {
      // Send disconnect to SharedWorker
      port.postMessage({ type: "disconnect" });

      // Resolve all pending claims as false
      for (const [, resolve] of pendingClaims) {
        resolve(false);
      }
      pendingClaims.clear();
      leaderState.clear();

      // Stop heartbeat
      if (heartbeatTimer != null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      // Remove beforeunload
      if (unloadHandler) {
        globalThis.removeEventListener("beforeunload", unloadHandler);
        unloadHandler = null;
      }

      // Revoke Blob URL to prevent memory leak (MF-12)
      if (blobUrlToRevoke) {
        URL.revokeObjectURL(blobUrlToRevoke);
        blobUrlToRevoke = null;
      }

      port.onmessage = null;
    },

    cleanupKey(key: HashedKey): void {
      leaderState.delete(key);
      port.postMessage({ type: "unregister", key });

      const resolve = pendingClaims.get(key);
      if (resolve) {
        pendingClaims.delete(key);
        resolve(false);
      }
    },
  };

  return api;
}

// ─── Helpers ───

function createBlobUrl(): string | null {
  try {
    const blob = new Blob([WORKER_CODE], { type: "application/javascript" });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}
