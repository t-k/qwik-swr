import type { InitOptions } from "./types/index.ts";
import { store } from "./cache/store.ts";
import { startGC, stopGC } from "./cache/gc.ts";
import { createBatchedStorage } from "../storage/batched.ts";
import { _resetEventManagerState } from "./cache/event-manager.ts";
import { timerCoordinator } from "./cache/timer-coordinator.ts";

let initialized = false;

/**
 * Initialize qwik-swr with optional CacheStorage plugin, GC config,
 * cross-tab sync, and performance optimizations.
 * Hydrates the in-memory cache from storage if provided.
 * Starts GC if configured (browser only).
 *
 * Idempotent: calling twice resets and re-initializes cleanly (SF-23).
 *
 * For subscription sync, call `initSubscriptionSync()` from "qwik-swr/subscription"
 * after this function.
 */
export async function initSWR(options?: InitOptions): Promise<void> {
  // Reset previous state to prevent double-wrapping (SF-23)
  if (initialized) {
    store._reset();
    stopGC();
    _resetEventManagerState();
    timerCoordinator._reset();
  }
  initialized = true;
  // Wrap storage with batching if configured
  let storage = options?.storage;
  const storageFlushInterval = options?.batching?.storageFlushInterval;
  if (storage && storageFlushInterval !== undefined && storageFlushInterval > 0) {
    storage = createBatchedStorage(storage, { flushInterval: storageFlushInterval });
  }

  await store.initStorage(storage, options?.hydration);
  startGC(options?.gc);

  // Notification batching: default to microtask (interval=0)
  const notifyInterval = options?.batching?.notifyInterval ?? 0;
  store.initScheduler(notifyInterval);

  // Cross-tab sync: enabled by default (store sync only)
  const syncEnabled = options?.sync?.enabled !== false;

  if (syncEnabled) {
    const channelName = options?.sync?.channelName ?? "qwik-swr";
    store.initSync(channelName);

    // Cross-tab fetch dedup
    if (options?.sync?.dedup) {
      const dedupTimeout = options.sync.dedupTimeout ?? 30_000;
      store.enableDedup(true, dedupTimeout);
    }
  }
}
