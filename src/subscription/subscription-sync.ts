import type { HashedKey, SubscriptionStatus, SWRError, SyncMessage } from "../types/index.ts";
import { serializeSWRError } from "../utils/error.ts";
import type { SyncChannelApi } from "../cache/sync-channel.ts";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface SubscriptionSyncConfig {
  dataSync: boolean;
  connectionDedup: boolean;
  heartbeatInterval: number; // ms
  failoverTimeout: number; // ms
}

export interface SubscriptionSyncApi {
  broadcastData(key: HashedKey, data: unknown): void;
  broadcastStatus(key: HashedKey, status: SubscriptionStatus): void;
  broadcastError(key: HashedKey, error: SWRError): void;
  claimLeadership(key: HashedKey): Promise<boolean>;
  resignLeadership(key: HashedKey): void;
  isLeader(key: HashedKey): boolean;
  handleMessage(msg: SyncMessage): void;
  cleanup(): void;
  cleanupKey(key: HashedKey): void;

  // Callbacks set by SubscriptionRegistry
  onRemoteData: ((key: HashedKey, data: unknown) => void) | null;
  onRemoteStatus: ((key: HashedKey, status: SubscriptionStatus) => void) | null;
  onRemoteError: ((key: HashedKey, error: SWRError) => void) | null;
  onLeaderChanged: ((key: HashedKey, isLocal: boolean) => void) | null;
}

// ═══════════════════════════════════════════════════════════════
// Internal state per key
// ═══════════════════════════════════════════════════════════════

interface LeaderState {
  leaderTabId: string | null;
  isLocalLeader: boolean;
  lastHeartbeat: number;
  /** Pending claims from other tabs during claim window */
  remoteClaims: Array<{ tabId: string; timestamp: number }>;
  /** Our claim timestamp */
  claimTimestamp: number;
  claimTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  failoverTimer: ReturnType<typeof setTimeout> | null;
  claimResolve: ((won: boolean) => void) | null;
}

// Claim window: wait for competing claims before deciding
const CLAIM_WINDOW_MS = 100;

// ═══════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════

export function createSubscriptionSync(
  channel: SyncChannelApi,
  config: SubscriptionSyncConfig,
): SubscriptionSyncApi {
  const leaderStates = new Map<HashedKey, LeaderState>();
  const tabId = channel.tabId;

  // ─── Internal helpers ───

  function getOrCreateState(key: HashedKey): LeaderState {
    let state = leaderStates.get(key);
    if (!state) {
      state = {
        leaderTabId: null,
        isLocalLeader: false,
        lastHeartbeat: 0,
        remoteClaims: [],
        claimTimestamp: 0,
        claimTimer: null,
        heartbeatTimer: null,
        failoverTimer: null,
        claimResolve: null,
      };
      leaderStates.set(key, state);
    }
    return state;
  }

  function clearStateTimers(state: LeaderState): void {
    if (state.claimTimer != null) {
      clearTimeout(state.claimTimer);
      state.claimTimer = null;
    }
    if (state.heartbeatTimer != null) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    if (state.failoverTimer != null) {
      clearTimeout(state.failoverTimer);
      state.failoverTimer = null;
    }
  }

  function startHeartbeat(key: HashedKey, state: LeaderState): void {
    if (state.heartbeatTimer != null) clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = setInterval(() => {
      channel.broadcast({
        version: 1,
        type: "sub-leader-heartbeat",
        tabId,
        key,
        timestamp: Date.now(),
      });
    }, config.heartbeatInterval);
  }

  function startFailoverTimer(key: HashedKey, state: LeaderState): void {
    if (state.failoverTimer != null) clearTimeout(state.failoverTimer);
    state.failoverTimer = setTimeout(() => {
      // Leader hasn't sent heartbeat in time -> re-elect
      state.leaderTabId = null;
      state.isLocalLeader = false;
      // Start new election
      void runElection(key);
    }, config.failoverTimeout);
  }

  function resolveElection(key: HashedKey, state: LeaderState): void {
    try {
      // Compare own claim vs all remote claims
      let winner = { tabId, timestamp: state.claimTimestamp };

      for (const claim of state.remoteClaims) {
        if (
          claim.timestamp < winner.timestamp ||
          (claim.timestamp === winner.timestamp && claim.tabId < winner.tabId)
        ) {
          winner = claim;
        }
      }

      const won = winner.tabId === tabId;
      state.isLocalLeader = won;
      state.leaderTabId = winner.tabId;
      state.remoteClaims = [];

      if (won) {
        startHeartbeat(key, state);
      } else {
        // Start failover timer as follower
        state.lastHeartbeat = Date.now();
        startFailoverTimer(key, state);
      }

      api.onLeaderChanged?.(key, won);
      state.claimResolve?.(won);
      state.claimResolve = null;
    } catch {
      // If resolveElection throws, assume local leader to avoid hanging Promise
      state.isLocalLeader = true;
      state.leaderTabId = tabId;
      state.remoteClaims = [];
      startHeartbeat(key, state);
      api.onLeaderChanged?.(key, true);
      state.claimResolve?.(true);
      state.claimResolve = null;
    }
  }

  async function runElection(key: HashedKey): Promise<boolean> {
    const state = getOrCreateState(key);

    // Clear existing timers
    clearStateTimers(state);

    state.claimTimestamp = Date.now();
    state.remoteClaims = [];

    if (!config.connectionDedup) {
      // No dedup: always "win" locally, no broadcast
      state.isLocalLeader = true;
      state.leaderTabId = tabId;
      api.onLeaderChanged?.(key, true);
      return true;
    }

    // Broadcast claim
    channel.broadcast({
      version: 1,
      type: "sub-leader-claim",
      tabId,
      key,
      timestamp: state.claimTimestamp,
    });

    return new Promise<boolean>((resolve) => {
      state.claimResolve = resolve;
      state.claimTimer = setTimeout(() => {
        state.claimTimer = null;
        resolveElection(key, state);
      }, CLAIM_WINDOW_MS);
    });
  }

  // ─── Message handler ───

  function handleMessage(msg: SyncMessage): void {
    // Echo filtering: ignore own messages
    if (msg.tabId === tabId) return;

    switch (msg.type) {
      case "sub-data": {
        if (!config.dataSync) return;
        api.onRemoteData?.(msg.key, msg.data);
        break;
      }
      case "sub-status": {
        if (!config.dataSync) return;
        api.onRemoteStatus?.(msg.key, msg.status);
        break;
      }
      case "sub-error": {
        if (!config.dataSync) return;
        api.onRemoteError?.(msg.key, msg.error as SWRError);
        break;
      }
      case "sub-leader-claim": {
        const state = leaderStates.get(msg.key);
        if (!state || state.claimResolve === null) return;
        // Collect competing claim during claim window (deduplicate by tabId)
        const existingIdx = state.remoteClaims.findIndex((c) => c.tabId === msg.tabId);
        if (existingIdx !== -1) {
          // Keep the earliest claim from the same tab
          if (msg.timestamp < state.remoteClaims[existingIdx]!.timestamp) {
            state.remoteClaims[existingIdx] = { tabId: msg.tabId, timestamp: msg.timestamp };
          }
        } else {
          state.remoteClaims.push({ tabId: msg.tabId, timestamp: msg.timestamp });
        }
        break;
      }
      case "sub-leader-heartbeat": {
        const state = leaderStates.get(msg.key);
        if (!state) return;
        state.lastHeartbeat = Date.now();
        state.leaderTabId = msg.tabId;
        // Reset failover timer
        if (state.failoverTimer != null) {
          startFailoverTimer(msg.key, state);
        }
        break;
      }
      case "sub-leader-resign": {
        const state = leaderStates.get(msg.key);
        if (!state) return;
        // Immediate re-election
        state.leaderTabId = null;
        state.isLocalLeader = false;
        clearStateTimers(state);
        void runElection(msg.key);
        break;
      }
      default:
        // Ignore non-subscription messages (cache sync types)
        break;
    }
  }

  // ─── API ───

  const api: SubscriptionSyncApi = {
    onRemoteData: null,
    onRemoteStatus: null,
    onRemoteError: null,
    onLeaderChanged: null,

    broadcastData(key: HashedKey, data: unknown): void {
      channel.broadcast({
        version: 1,
        type: "sub-data",
        tabId,
        key,
        data,
        timestamp: Date.now(),
      });
    },

    broadcastStatus(key: HashedKey, status: SubscriptionStatus): void {
      channel.broadcast({
        version: 1,
        type: "sub-status",
        tabId,
        key,
        status,
        timestamp: Date.now(),
      });
    },

    broadcastError(key: HashedKey, error: SWRError): void {
      channel.broadcast({
        version: 1,
        type: "sub-error",
        tabId,
        key,
        error: serializeSWRError(error),
        timestamp: Date.now(),
      });
    },

    claimLeadership(key: HashedKey): Promise<boolean> {
      return runElection(key);
    },

    resignLeadership(key: HashedKey): void {
      const state = leaderStates.get(key);
      if (!state) return;

      if (state.isLocalLeader) {
        channel.broadcast({
          version: 1,
          type: "sub-leader-resign",
          tabId,
          key,
          timestamp: Date.now(),
        });
      }

      state.isLocalLeader = false;
      state.leaderTabId = null;
      clearStateTimers(state);
    },

    isLeader(key: HashedKey): boolean {
      const state = leaderStates.get(key);
      return state?.isLocalLeader ?? false;
    },

    handleMessage,

    cleanup(): void {
      // Broadcast leader resignation for all keys where we are leader (SF-20)
      for (const [key, state] of leaderStates) {
        if (state.isLocalLeader) {
          channel.broadcast({
            version: 1,
            type: "sub-leader-resign",
            tabId,
            key,
            timestamp: Date.now(),
          });
        }
        clearStateTimers(state);
        if (state.claimResolve) {
          state.claimResolve(false);
          state.claimResolve = null;
        }
      }
      leaderStates.clear();
    },

    cleanupKey(key: HashedKey): void {
      const state = leaderStates.get(key);
      if (!state) return;
      clearStateTimers(state);
      if (state.claimResolve) {
        state.claimResolve(false);
        state.claimResolve = null;
      }
      leaderStates.delete(key);
    },
  };

  return api;
}
