import type { SyncConfig } from "../types/index.ts";
import { store } from "../cache/store.ts";
import { isDev } from "../utils/env.ts";
import { subscriptionRegistry } from "./subscription-registry.ts";
import { createSyncChannel } from "../cache/sync-channel.ts";
import { createSharedWorkerSync } from "./shared-worker-sync.ts";

export interface SubscriptionSyncOptions {
  sync?: SyncConfig;
}

/**
 * Initialize subscription-specific cross-tab sync.
 *
 * Call this after `initSWR()` to enable subscription data sync and/or
 * connection dedup across tabs.
 *
 * Store sync must already be initialized (initSWR handles it).
 */
export function initSubscriptionSync(options?: SubscriptionSyncOptions): void {
  const syncEnabled = options?.sync?.enabled !== false;
  const subSync = options?.sync?.subscriptionSync ?? false;
  const subDedup = options?.sync?.subscriptionDedup ?? false;

  if (!syncEnabled || (!subSync && !subDedup)) return;

  const channelName = options?.sync?.channelName ?? "qwik-swr";

  const heartbeatInterval = options?.sync?.heartbeatInterval ?? 3000;
  const failoverTimeout = options?.sync?.failoverTimeout ?? 10000;

  // Ensure failoverTimeout is long enough to receive at least one heartbeat
  if (failoverTimeout < heartbeatInterval) {
    if (isDev()) {
      console.warn(
        `[qwik-swr] failoverTimeout (${failoverTimeout}ms) is shorter than heartbeatInterval (${heartbeatInterval}ms). ` +
          `This will cause premature leader failover. Clamping to heartbeatInterval * 2.`,
      );
    }
  }
  const effectiveFailoverTimeout =
    failoverTimeout < heartbeatInterval ? heartbeatInterval * 2 : failoverTimeout;

  const subSyncConfig = {
    dataSync: subSync,
    connectionDedup: subDedup,
    heartbeatInterval,
    failoverTimeout: effectiveFailoverTimeout,
  };

  // Try SharedWorker first (instant leader assignment, no claim window)
  const swApi = createSharedWorkerSync(
    subSyncConfig,
    channelName,
    options?.sync?.subscriptionWorkerUrl,
  );

  if (swApi) {
    // SharedWorker available: store uses its own BroadcastChannel,
    // subscriptions use SharedWorker (separate channels)
    store.initSync(channelName);
    subscriptionRegistry.initSyncDirect(swApi, subSyncConfig);
  } else {
    // Fallback: shared BroadcastChannel with message routing
    const syncChannel = createSyncChannel(channelName, (msg) => {
      if (msg.type.startsWith("sub-")) {
        subscriptionRegistry.handleSyncMessage(msg);
      } else {
        store.handleSyncMessage(msg);
      }
    });

    if (syncChannel) {
      store.initSyncWithChannel(syncChannel);
      subscriptionRegistry.initSync(syncChannel, subSyncConfig);
    }
  }
}
