import type {
  HashedKey,
  ValidKey,
  SubscriptionStatus,
  SWRError,
  SyncMessage,
} from "../types/index.ts";
import { toSWRError } from "../utils/error.ts";
import type { SyncChannelApi } from "../cache/sync-channel.ts";
import {
  createSubscriptionSync,
  type SubscriptionSyncConfig,
  type SubscriptionSyncApi,
} from "./subscription-sync.ts";

/** Default connection timeout in ms (shared with JSDoc in types/index.ts) */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
import { isDev } from "../utils/env.ts";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

type SubscriberResult = { unsubscribe: () => void } | Promise<{ unsubscribe: () => void }>;

type SubscriberFn = (
  key: any,
  callbacks: {
    onData: (data: any) => void;
    onError: (error: Error | SWRError) => void;
  },
) => SubscriberResult;

export interface SubscriptionObserver {
  id: string;
  onData: (data: unknown) => void;
  onError: (error: SWRError) => void;
  onStatusChange: (status: SubscriptionStatus) => void;
}

interface SubscriptionConfig {
  maxRetries: number;
  retryInterval: number;
  /** Connection timeout in ms. 0 = disabled. Default: 30000 */
  connectionTimeout?: number;
}

interface SharedConnection {
  hashedKey: HashedKey;
  rawKey: ValidKey;
  status: SubscriptionStatus;
  latestData: unknown;
  hasReceivedData: boolean;
  latestError: SWRError | undefined;
  subscriberFn: SubscriberFn;
  maxRetries: number;
  retryInterval: number;
  connectionTimeout: number;
  // Mutable refs
  retryCount: number;
  cancelled: boolean;
  unsubFn: (() => void) | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  connectionTimer: ReturnType<typeof setTimeout> | null;
  observers: Map<string, SubscriptionObserver>;
  /** true when this tab is a follower (no local connection) */
  isFollower: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Public API interface
// ═══════════════════════════════════════════════════════════════

export interface SubscriptionRegistryApi {
  initSync(channel: SyncChannelApi, config: SubscriptionSyncConfig): void;
  initSyncDirect(api: SubscriptionSyncApi, config: SubscriptionSyncConfig): void;
  handleSyncMessage(msg: SyncMessage): void;
  attach(
    hashedKey: HashedKey,
    rawKey: ValidKey,
    observer: SubscriptionObserver,
    subscriberFn: SubscriberFn,
    config: SubscriptionConfig,
  ): void;
  detach(hashedKey: HashedKey, observerId: string): void;
  reconnect(hashedKey: HashedKey): Promise<void>;
  getStatus(hashedKey: HashedKey): SubscriptionStatus | null;
  _reset(): void;
  _getConnectionCount(): number;
  _getObserverCount(hashedKey: HashedKey): number;
}

// ═══════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════

function createSubscriptionRegistry(): SubscriptionRegistryApi {
  // Private state (closure variables)
  const connections = new Map<HashedKey, SharedConnection>();
  let syncApi: SubscriptionSyncApi | null = null;
  let syncConfig: SubscriptionSyncConfig | null = null;
  let unloadListener: (() => void) | null = null;

  // ─── Private functions ───

  function wireSyncCallbacks(): void {
    if (!syncApi) return;
    syncApi.onRemoteData = (key, data) => handleRemoteData(key, data);
    syncApi.onRemoteStatus = (key, status) => handleRemoteStatus(key, status);
    syncApi.onRemoteError = (key, error) => handleRemoteError(key, error);
    syncApi.onLeaderChanged = (key, isLocal) => handleLeaderChanged(key, isLocal);
  }

  function registerUnloadHandler(): void {
    if (typeof globalThis !== "undefined" && typeof globalThis.addEventListener === "function") {
      const handler = () => {
        for (const [key] of connections) {
          syncApi?.resignLeadership(key);
        }
      };
      unloadListener = handler;
      globalThis.addEventListener("beforeunload", handler);
    }
  }

  function closeSync(): void {
    if (syncApi) {
      syncApi.cleanup();
      syncApi = null;
    }
    if (unloadListener) {
      globalThis.removeEventListener("beforeunload", unloadListener);
      unloadListener = null;
    }
    syncConfig = null;
  }

  // ─── Remote data handlers ───

  function handleRemoteData(key: HashedKey, data: unknown): void {
    const connection = connections.get(key);
    if (!connection) return;

    connection.latestData = data;
    connection.hasReceivedData = true;
    connection.latestError = undefined;

    for (const observer of Array.from(connection.observers.values())) {
      try {
        observer.onData(data);
      } catch (err) {
        if (isDev()) {
          console.warn(`[qwik-swr] observer.onData threw for key="${key as string}":`, err);
        }
      }
    }
  }

  function handleRemoteStatus(key: HashedKey, status: SubscriptionStatus): void {
    const connection = connections.get(key);
    if (!connection) return;

    connection.status = status;
    for (const observer of Array.from(connection.observers.values())) {
      try {
        observer.onStatusChange(status);
      } catch (err) {
        if (isDev()) {
          console.warn(`[qwik-swr] observer.onStatusChange threw for key="${key as string}":`, err);
        }
      }
    }
  }

  function handleRemoteError(key: HashedKey, error: SWRError): void {
    const connection = connections.get(key);
    if (!connection) return;

    connection.latestError = error;
    for (const observer of Array.from(connection.observers.values())) {
      try {
        observer.onError(error);
      } catch (err) {
        if (isDev()) {
          console.warn(`[qwik-swr] observer.onError threw for key="${key as string}":`, err);
        }
      }
    }
  }

  function handleLeaderChanged(key: HashedKey, isLocal: boolean): void {
    const connection = connections.get(key);
    if (!connection) return;

    if (isLocal) {
      // Became leader: start real connection if follower
      connection.isFollower = false;
      if (!connection.unsubFn && !connection.cancelled) {
        startConnection(connection);
      }
    } else {
      // Became follower: stop real connection if running
      connection.isFollower = true;
      if (connection.unsubFn) {
        connection.unsubFn();
        connection.unsubFn = null;
      }
      if (connection.retryTimer) {
        clearTimeout(connection.retryTimer);
        connection.retryTimer = null;
      }
    }
  }

  // ─── Connection management ───

  function startConnection(connection: SharedConnection): void {
    if (connection.cancelled) return;
    // Don't start real connection for followers
    if (connection.isFollower) return;

    if (isDev()) {
      // eslint-disable-next-line no-console
      console.log(
        `[qwik-swr] startConnection key="${connection.hashedKey}" observers=${connection.observers.size}`,
      );
    }

    setStatus(connection, "connecting");

    // Start connection timeout if configured
    if (connection.connectionTimer) {
      clearTimeout(connection.connectionTimer);
      connection.connectionTimer = null;
    }
    if (connection.connectionTimeout > 0) {
      connection.connectionTimer = setTimeout(() => {
        if (connection.cancelled) return;
        if (connection.status === "live") return; // already connected

        connection.connectionTimer = null;

        const swrError = toSWRError(
          new Error(`Connection timeout after ${connection.connectionTimeout}ms`),
          connection.retryCount,
        );
        scheduleRetry(connection, swrError, { closeExisting: true });
      }, connection.connectionTimeout);
    }

    try {
      const result = connection.subscriberFn(connection.rawKey, {
        onData: (data: unknown) => {
          if (connection.cancelled) return;

          // Clear connection timeout on first data
          if (connection.connectionTimer) {
            clearTimeout(connection.connectionTimer);
            connection.connectionTimer = null;
          }

          connection.latestData = data;
          connection.hasReceivedData = true;
          connection.latestError = undefined;

          if (connection.retryCount > 0 || connection.status !== "live") {
            connection.retryCount = 0;
            setStatus(connection, "live");
          }

          // Broadcast to all observers (snapshot to avoid mutation during iteration)
          for (const observer of Array.from(connection.observers.values())) {
            observer.onData(data);
          }

          // Broadcast to other tabs (sync)
          syncApi?.broadcastData(connection.hashedKey, data);
        },
        onError: (err: Error | SWRError) => {
          if (connection.cancelled) return;

          // Clear connection timeout (prevents double-retry when error fires
          // before connectionTimeout expires)
          if (connection.connectionTimer) {
            clearTimeout(connection.connectionTimer);
            connection.connectionTimer = null;
          }

          const swrError =
            "type" in err && "timestamp" in err
              ? (err as SWRError)
              : toSWRError(err, connection.retryCount);
          scheduleRetry(connection, swrError, { closeExisting: true });
        },
      });

      // Handle sync/async subscriber result
      handleSubscriberResult(connection, result);
    } catch (err) {
      if (connection.cancelled) return;
      scheduleRetry(connection, toSWRError(err, connection.retryCount));
    }
  }

  function handleSubscriberResult(connection: SharedConnection, result: SubscriberResult): void {
    if (
      result instanceof Promise ||
      (result && typeof (result as unknown as Promise<unknown>).then === "function")
    ) {
      (result as Promise<{ unsubscribe: () => void }>)
        .then((resolved) => {
          if (connection.cancelled) {
            resolved.unsubscribe();
          } else {
            connection.unsubFn = resolved.unsubscribe;
          }
        })
        .catch((err) => {
          if (connection.cancelled) return;
          scheduleRetry(connection, toSWRError(err, connection.retryCount));
        });
      return;
    }

    const syncResult = result as { unsubscribe: () => void };
    if (connection.cancelled) {
      syncResult.unsubscribe();
    } else {
      connection.unsubFn = syncResult.unsubscribe;
    }
  }

  /**
   * Handle error and schedule retry with exponential backoff (MF-4).
   */
  function scheduleRetry(
    connection: SharedConnection,
    swrError: SWRError,
    opts?: { closeExisting?: boolean },
  ): void {
    connection.latestError = swrError;

    for (const observer of Array.from(connection.observers.values())) {
      observer.onError(swrError);
    }

    syncApi?.broadcastError(connection.hashedKey, swrError);

    connection.retryCount++;

    if (connection.retryCount > connection.maxRetries) {
      setStatus(connection, "disconnected");
      return;
    }

    setStatus(connection, "connecting");

    if (opts?.closeExisting) {
      connection.unsubFn?.();
      connection.unsubFn = null;
    }

    const delay = connection.retryInterval * 2 ** (connection.retryCount - 1);
    if (connection.retryTimer) clearTimeout(connection.retryTimer);
    connection.retryTimer = setTimeout(() => {
      if (!connection.cancelled) {
        startConnection(connection);
      }
    }, delay);
  }

  function setStatus(connection: SharedConnection, status: SubscriptionStatus): void {
    if (isDev() && status === "disconnected") {
      // eslint-disable-next-line no-console
      console.warn(
        `[qwik-swr] setStatus("disconnected") key="${connection.hashedKey}" observers=${connection.observers.size} retryCount=${connection.retryCount}`,
      );
      // eslint-disable-next-line no-console
      console.trace("[qwik-swr] setStatus disconnected call stack");
    }
    connection.status = status;
    for (const observer of Array.from(connection.observers.values())) {
      observer.onStatusChange(status);
    }
    // Broadcast status to other tabs (sync)
    syncApi?.broadcastStatus(connection.hashedKey, status);
  }

  function closeConnection(connection: SharedConnection): void {
    if (isDev()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[qwik-swr] closeConnection key="${connection.hashedKey}" observers=${connection.observers.size}`,
      );
      // eslint-disable-next-line no-console
      console.trace("[qwik-swr] closeConnection call stack");
    }
    connection.cancelled = true;
    if (connection.retryTimer) {
      clearTimeout(connection.retryTimer);
      connection.retryTimer = null;
    }
    if (connection.connectionTimer) {
      clearTimeout(connection.connectionTimer);
      connection.connectionTimer = null;
    }
    connection.unsubFn?.();
    connection.unsubFn = null;
  }

  // ─── Public API ───

  return {
    initSync(channel: SyncChannelApi, config: SubscriptionSyncConfig): void {
      closeSync();
      syncConfig = config;
      syncApi = createSubscriptionSync(channel, config);
      wireSyncCallbacks();
      registerUnloadHandler();
    },

    initSyncDirect(api: SubscriptionSyncApi, config: SubscriptionSyncConfig): void {
      closeSync();
      syncConfig = config;
      syncApi = api;
      wireSyncCallbacks();
    },

    handleSyncMessage(msg: SyncMessage): void {
      syncApi?.handleMessage(msg);
    },

    attach(
      hashedKey: HashedKey,
      rawKey: ValidKey,
      observer: SubscriptionObserver,
      subscriberFn: SubscriberFn,
      config: SubscriptionConfig,
    ): void {
      const existing = connections.get(hashedKey);

      if (existing) {
        // Add observer to existing connection
        existing.observers.set(observer.id, observer);

        // Deliver latest state to the new observer
        if (existing.hasReceivedData) {
          observer.onData(existing.latestData);
        }
        if (existing.latestError) {
          observer.onError(existing.latestError);
        }
        // Always deliver current status
        observer.onStatusChange(existing.status);

        if (isDev()) {
          if (
            existing.maxRetries !== config.maxRetries ||
            existing.retryInterval !== config.retryInterval
          ) {
            // eslint-disable-next-line no-console
            console.warn(
              `[qwik-swr] Subscription key "${hashedKey}" already has config. ` +
                `Different options from observer "${observer.id}" will be ignored.`,
            );
          }
        }

        return;
      }

      // Create new shared connection
      const connection: SharedConnection = {
        hashedKey,
        rawKey,
        status: "connecting",
        latestData: undefined,
        hasReceivedData: false,
        latestError: undefined,
        subscriberFn,
        maxRetries: config.maxRetries,
        retryInterval: config.retryInterval,
        connectionTimeout: config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT_MS,
        retryCount: 0,
        cancelled: false,
        unsubFn: null,
        retryTimer: null,
        connectionTimer: null,
        observers: new Map([[observer.id, observer]]),
        isFollower: false,
      };

      connections.set(hashedKey, connection);

      // Connection dedup: claim leadership before starting connection
      if (syncApi && syncConfig?.connectionDedup) {
        connection.isFollower = true; // Assume follower until election resolves
        void syncApi.claimLeadership(hashedKey).then((_won) => {
          // handleLeaderChanged callback handles connection start/stop
        });
      } else {
        startConnection(connection);
      }
    },

    detach(hashedKey: HashedKey, observerId: string): void {
      const connection = connections.get(hashedKey);
      if (!connection) return;

      if (isDev()) {
        // eslint-disable-next-line no-console
        console.warn(
          `[qwik-swr] detach observer="${observerId}" key="${hashedKey}" remaining=${connection.observers.size - 1}`,
        );
        // eslint-disable-next-line no-console
        console.trace("[qwik-swr] detach call stack");
      }

      connection.observers.delete(observerId);

      if (connection.observers.size === 0) {
        // Resign leadership if we're the leader
        if (syncApi) {
          syncApi.resignLeadership(hashedKey);
          syncApi.cleanupKey(hashedKey);
        }
        closeConnection(connection);
        connections.delete(hashedKey);
      }
    },

    async reconnect(hashedKey: HashedKey): Promise<void> {
      const connection = connections.get(hashedKey);
      if (!connection) return;

      // Close current connection without removing from registry
      connection.cancelled = true;
      if (connection.retryTimer) {
        clearTimeout(connection.retryTimer);
        connection.retryTimer = null;
      }
      if (connection.connectionTimer) {
        clearTimeout(connection.connectionTimer);
        connection.connectionTimer = null;
      }
      connection.unsubFn?.();
      connection.unsubFn = null;

      // Reset state
      connection.cancelled = false;
      connection.retryCount = 0;
      connection.latestError = undefined;

      // Re-establish connection
      startConnection(connection);
    },

    getStatus(hashedKey: HashedKey): SubscriptionStatus | null {
      const connection = connections.get(hashedKey);
      return connection ? connection.status : null;
    },

    _reset(): void {
      for (const [, connection] of connections) {
        closeConnection(connection);
      }
      connections.clear();
      closeSync();
    },

    _getConnectionCount(): number {
      return connections.size;
    },

    _getObserverCount(hashedKey: HashedKey): number {
      return connections.get(hashedKey)?.observers.size ?? 0;
    },
  };
}

// ─── Module Singleton Export ───
export const subscriptionRegistry = createSubscriptionRegistry();
