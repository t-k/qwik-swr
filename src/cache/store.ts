import type {
  HashedKey,
  ValidKey,
  CacheEntry,
  SWRError,
  FetchStatus,
  ResolvedQueryConfig,
  FetcherCtx,
  CacheStorage,
  CacheExport,
  ImportOptions,
  DebugSnapshot,
  Fetcher,
  SyncMessage,
} from "../types/index.ts";
import type { Observer } from "./types.ts";
import { hashKey } from "../utils/hash.ts";
import { createSyncChannel } from "./sync-channel.ts";
import type { SyncChannelApi } from "./sync-channel.ts";
import { createNotificationScheduler } from "./notification-scheduler.ts";
import type { SchedulerObserver } from "./notification-scheduler.ts";
import { createDebugSnapshot, exportCache, importEntries } from "./store-debug.ts";
import { createStoreState } from "./store-context.ts";
import type { StoreState } from "./store-context.ts";
import { createStorageManager } from "./store-storage.ts";
import { createSyncHandler } from "./store-sync.ts";
import { createFetchEngine } from "./store-fetch.ts";
import { isDev } from "../utils/env.ts";

// Default config for prefetch/revalidation when no queryConfig is set
const DEFAULT_QUERY_CONFIG: ResolvedQueryConfig = {
  enabled: true,
  eagerness: "visible",
  staleTime: 30_000,
  cacheTime: 300_000,
  dedupingInterval: 2_000,
  revalidateOn: [],
  refreshInterval: 0,
  retry: 3,
  retryInterval: 1000,
  timeout: 30_000,
};

// ═══════════════════════════════════════════════════════════════
// Public API interface
// ═══════════════════════════════════════════════════════════════

export interface CacheStoreApi {
  // Init
  initStorage(storage?: CacheStorage, hydration?: "eager" | "lazy"): Promise<void>;
  initSync(channelName: string): void;
  initSyncWithChannel(channel: SyncChannelApi): void;
  initScheduler(interval: number): void;
  flushNotifications(): void;
  closeSync(): void;
  enableDedup(enabled: boolean, timeout?: number): void;
  handleSyncMessage(msg: SyncMessage): void;

  // Observer Management
  attachObserver(hashedKey: HashedKey, observer: Observer, opts: ResolvedQueryConfig): void;
  detachObserver(hashedKey: HashedKey, observer: Observer): void;

  // Fetch Control
  ensureFetch<K extends ValidKey, Data>(
    hashedKey: HashedKey,
    rawKey: K,
    fetcher: (ctx: FetcherCtx<K>) => Data | Promise<Data>,
  ): void;
  forceRevalidate<K extends ValidKey, Data>(
    hashedKey: HashedKey,
    rawKey: K,
    fetcher: (ctx: FetcherCtx<K>) => Data | Promise<Data>,
  ): Promise<Data | undefined>;

  // Cache Operations
  getCache<Data>(hashedKey: HashedKey): CacheEntry<Data> | null;
  setCache<Data>(hashedKey: HashedKey, entry: CacheEntry<Data>): void;
  deleteCache(hashedKey: HashedKey): void;
  clearCache(): void;
  revalidateByKey(hashedKey: HashedKey): boolean;
  keys(): HashedKey[];

  // Online/Offline
  readonly isOnline: boolean;
  setOnline(online: boolean): void;

  // Observer Count (for GC)
  getObserverCount(hashedKey: HashedKey): number;
  getCacheTime(hashedKey: HashedKey): number;

  // Debug / Export / Import
  getDebugSnapshot(): DebugSnapshot;
  export(): CacheExport;
  import(data: CacheExport, options?: ImportOptions): void;

  // Prefetch
  prefetch<Data, K extends ValidKey>(
    key: K,
    fetcher: Fetcher<Data, K>,
    options?: { force?: boolean },
  ): { promise: Promise<void>; abort: () => void };

  // Test helpers
  _reset(): void;
  _getQueryConfigMapSize(): number;
  _getCooldownMapSize(): number;
}

// ═══════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════

function createCacheStore(): CacheStoreApi {
  const state: StoreState = createStoreState();

  // ─── Storage sub-module ───
  const storageMgr = createStorageManager(state);

  // ─── Observer Notification (inline — small and cross-cutting) ───

  function notifyObservers(hashedKey: HashedKey, entry: CacheEntry): void {
    if (state.scheduler) {
      state.scheduler.enqueueData(hashedKey, entry);
      return;
    }
    // Direct notification (no scheduler configured)
    const set = state.observerRegistry.get(hashedKey);
    if (!set) return;
    for (const ob of set) {
      ob.hasData = true;
      ob.onData(entry);
    }
  }

  /** Direct notification bypassing scheduler (for attachObserver initial hit) */
  function notifyObserverDirect(observer: Observer, entry: CacheEntry): void {
    observer.hasData = true;
    observer.onData(entry);
  }

  function notifyError(hashedKey: HashedKey, error: SWRError): void {
    if (state.scheduler) {
      state.scheduler.enqueueError(hashedKey, error);
      return;
    }
    const set = state.observerRegistry.get(hashedKey);
    if (!set) return;
    for (const ob of set) {
      ob.onError(error);
    }
  }

  function broadcastFetchStatus(hashedKey: HashedKey, status: FetchStatus): void {
    if (state.scheduler) {
      state.scheduler.enqueueFetchStatus(hashedKey, status);
      return;
    }
    const set = state.observerRegistry.get(hashedKey);
    if (!set) return;
    for (const ob of set) {
      ob.onFetchStatusChange(status);
    }
  }

  // ─── Sync sub-module ───
  const syncHandler = createSyncHandler(state, {
    notifyObservers,
    safeStorageOp: storageMgr.safeStorageOp,
  });

  // ─── Fetch sub-module ───
  const fetchEngine = createFetchEngine(state, {
    notifyObservers,
    notifyError,
    broadcastFetchStatus,
    safeStorageOp: storageMgr.safeStorageOp,
  });

  // ─── Public API ───

  const api: CacheStoreApi = {
    // ─── Init ───

    initStorage: storageMgr.initStorage,

    initSync(channelName: string): void {
      api.closeSync();
      state.syncChannel = createSyncChannel(channelName, (msg) => api.handleSyncMessage(msg));
    },

    initSyncWithChannel(channel: SyncChannelApi): void {
      api.closeSync();
      state.syncChannel = channel;
    },

    initScheduler(interval: number): void {
      state.scheduler?._reset();
      state.scheduler = createNotificationScheduler(
        interval,
        (key) => state.observerRegistry.get(key) as ReadonlySet<SchedulerObserver> | undefined,
      );
    },

    flushNotifications(): void {
      state.scheduler?.flush();
    },

    closeSync(): void {
      if (state.syncChannel) {
        state.syncChannel.close();
        state.syncChannel = null;
      }
    },

    enableDedup: syncHandler.enableDedup,
    handleSyncMessage: syncHandler.handleSyncMessage,

    // ─── Test helpers ───

    _getQueryConfigMapSize(): number {
      return state.queryConfigMap.size;
    },

    _getCooldownMapSize(): number {
      return state.cooldownMap.size;
    },

    _reset(): void {
      api.closeSync();
      state.scheduler?._reset();
      state.scheduler = null;
      for (const [, inflight] of state.inflightMap) {
        inflight.abortController.abort();
      }
      state.cacheMap.clear();
      state.inflightMap.clear();
      for (const [, record] of state.cooldownMap) {
        clearTimeout(record.timerId);
      }
      state.cooldownMap.clear();
      state.queryConfigMap.clear();
      state.observerRegistry.clear();
      state.latestRequestId.clear();
      state.fetcherMap.clear();
      state.rawKeyMap.clear();
      state.pendingKeys.clear();
      state.nextRequestId = 1;
      state.storage = null;
      state.storageKeyIndex = null;
      state.hydratedKeys.clear();
      state.pendingHydrations.clear();
      state.dedupEnabled = false;
      state.dedupTimeout = 30_000;
      for (const [, timerId] of state.remoteInflight) {
        clearTimeout(timerId);
      }
      state.remoteInflight.clear();
      state.isOnline = true;
    },

    // ═══════════════════════════════════════════════════════════════
    // Observer Management
    // ═══════════════════════════════════════════════════════════════

    attachObserver(hashedKey: HashedKey, observer: Observer, opts: ResolvedQueryConfig): void {
      // QueryConfig fixation (A plan)
      if (!state.queryConfigMap.has(hashedKey)) {
        state.queryConfigMap.set(hashedKey, opts);
      } else if (isDev()) {
        const existing = state.queryConfigMap.get(hashedKey)!;
        if (
          existing.cacheTime !== opts.cacheTime ||
          existing.staleTime !== opts.staleTime ||
          existing.dedupingInterval !== opts.dedupingInterval
        ) {
          // eslint-disable-next-line no-console
          console.warn(
            `[qwik-swr] Key "${hashedKey}" already has QueryConfig. ` +
              `Different options from observer "${observer.id}" will be ignored. ` +
              `Use a different key for different cache policies.`,
          );
        }
      }

      // Add to registry
      const set = state.observerRegistry.get(hashedKey) ?? new Set<Observer>();
      set.add(observer);
      state.observerRegistry.set(hashedKey, set);

      // Reflect observerCount in active inflight
      const inflight = state.inflightMap.get(hashedKey);
      if (inflight) inflight.observerCount = set.size;

      // On-demand hydration from storage (lazy mode)
      const hydrationResult = storageMgr.hydrateKey(hashedKey);

      // Immediate cache hit notification (direct, not batched — no delay for first data)
      const entry = state.cacheMap.get(hashedKey);
      if (entry) {
        notifyObserverDirect(observer, entry as CacheEntry<any>);
      } else if (hydrationResult instanceof Promise) {
        // Async hydration: notify observers when data becomes available (MF-1)
        hydrationResult.then(() => {
          const hydrated = state.cacheMap.get(hashedKey);
          if (hydrated) {
            notifyObservers(hashedKey, hydrated);
          }
        });
      }
    },

    detachObserver(hashedKey: HashedKey, observer: Observer): void {
      const set = state.observerRegistry.get(hashedKey);
      if (!set) return;

      set.delete(observer);
      if (set.size === 0) {
        state.observerRegistry.delete(hashedKey);
        // queryConfigMap is NOT cleaned here — GC needs cacheTime for orphaned entries.
        // Cleanup happens in deleteCache() (called by GC or user).
      }

      // Update inflight observerCount
      const inflight = state.inflightMap.get(hashedKey);
      if (inflight) {
        const size = state.observerRegistry.get(hashedKey)?.size ?? 0;
        inflight.observerCount = size;

        if (size === 0) {
          inflight.abortController.abort();
          state.inflightMap.delete(hashedKey);
        }
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // Fetch Control
    // ═══════════════════════════════════════════════════════════════

    ensureFetch: fetchEngine.ensureFetch,

    forceRevalidate<K extends ValidKey, Data>(
      hashedKey: HashedKey,
      rawKey: K,
      fetcher: (ctx: FetcherCtx<K>) => Data | Promise<Data>,
    ): Promise<Data | undefined> {
      return fetchEngine.forceRevalidate(hashedKey, rawKey, fetcher, DEFAULT_QUERY_CONFIG);
    },

    // ═══════════════════════════════════════════════════════════════
    // Cache Operations
    // ═══════════════════════════════════════════════════════════════

    getCache<Data>(hashedKey: HashedKey): CacheEntry<Data> | null {
      storageMgr.hydrateKey(hashedKey);
      return (state.cacheMap.get(hashedKey) as CacheEntry<Data> | undefined) ?? null;
    },

    setCache<Data>(hashedKey: HashedKey, entry: CacheEntry<Data>): void {
      state.cacheMap.set(hashedKey, entry as CacheEntry);
      storageMgr.safeStorageOp(state.storage?.set(hashedKey, entry), "set", hashedKey);
      notifyObservers(hashedKey, entry as CacheEntry);
      state.syncChannel?.broadcast({
        version: 1,
        type: "set",
        tabId: state.syncChannel.tabId,
        key: hashedKey,
        entry: entry as CacheEntry,
        timestamp: entry.timestamp,
      });
    },

    deleteCache(hashedKey: HashedKey): void {
      // Abort inflight
      const inflight = state.inflightMap.get(hashedKey);
      if (inflight) {
        inflight.abortController.abort();
        state.inflightMap.delete(hashedKey);
      }
      const cooldown = state.cooldownMap.get(hashedKey);
      if (cooldown) clearTimeout(cooldown.timerId);
      state.cooldownMap.delete(hashedKey);

      // Delete from cache + storage + fetcher + queryConfig + rawKey + requestId
      state.cacheMap.delete(hashedKey);
      state.fetcherMap.delete(hashedKey);
      state.rawKeyMap.delete(hashedKey);
      state.queryConfigMap.delete(hashedKey);
      state.latestRequestId.delete(hashedKey);
      storageMgr.safeStorageOp(state.storage?.delete(hashedKey), "delete", hashedKey);

      // Notify observers: data cleared
      const set = state.observerRegistry.get(hashedKey);
      if (set) {
        for (const ob of set) {
          ob.hasData = false;
          ob.onData({ data: undefined, timestamp: 0 });
        }
      }

      state.syncChannel?.broadcast({
        version: 1,
        type: "delete",
        tabId: state.syncChannel.tabId,
        key: hashedKey,
        timestamp: Date.now(),
      });
    },

    clearCache(): void {
      // Abort all inflights
      for (const [, inflight] of state.inflightMap) {
        inflight.abortController.abort();
      }
      state.inflightMap.clear();
      for (const [, record] of state.cooldownMap) {
        clearTimeout(record.timerId);
      }
      state.cooldownMap.clear();
      state.cacheMap.clear();
      state.queryConfigMap.clear();
      state.latestRequestId.clear();
      state.fetcherMap.clear();
      state.rawKeyMap.clear();
      storageMgr.safeStorageOp(state.storage?.clear(), "clear");

      state.syncChannel?.broadcast({
        version: 1,
        type: "clear",
        tabId: state.syncChannel.tabId,
        timestamp: Date.now(),
      });
    },

    revalidateByKey(hashedKey: HashedKey): boolean {
      const fetcher = state.fetcherMap.get(hashedKey);
      if (!fetcher) return false;

      // Get rawKey from first observer, or fallback to rawKeyMap (for prefetched keys)
      let rawKey: ValidKey | undefined;
      const observers = state.observerRegistry.get(hashedKey);
      if (observers && observers.size > 0) {
        const firstObserver = observers.values().next().value;
        if (firstObserver) rawKey = firstObserver.lastRawKey;
      }
      if (rawKey === undefined) {
        rawKey = state.rawKeyMap.get(hashedKey);
      }
      if (rawKey === undefined) return false;

      void api.forceRevalidate(hashedKey, rawKey, fetcher).catch(() => {});
      return true;
    },

    keys(): HashedKey[] {
      return [...state.cacheMap.keys()];
    },

    get isOnline(): boolean {
      return state.isOnline;
    },

    setOnline(online: boolean): void {
      fetchEngine.setOnline(online, api.ensureFetch);
    },

    // ═══════════════════════════════════════════════════════════════
    // Observer Count (for GC)
    // ═══════════════════════════════════════════════════════════════

    getObserverCount(hashedKey: HashedKey): number {
      return state.observerRegistry.get(hashedKey)?.size ?? 0;
    },

    getCacheTime(hashedKey: HashedKey): number {
      const cfg = state.queryConfigMap.get(hashedKey);
      return cfg?.cacheTime ?? 300000; // Default: 5 minutes
    },

    // ═══════════════════════════════════════════════════════════════
    // Debug Snapshot (for Devtools)
    // ═══════════════════════════════════════════════════════════════

    getDebugSnapshot(): DebugSnapshot {
      return createDebugSnapshot({
        cacheMap: state.cacheMap,
        observerRegistry: state.observerRegistry,
        queryConfigMap: state.queryConfigMap,
        inflightMap: state.inflightMap,
      });
    },

    // ═══════════════════════════════════════════════════════════════
    // Export / Import (for Devtools)
    // ═══════════════════════════════════════════════════════════════

    export(): CacheExport {
      return exportCache(state.cacheMap);
    },

    import(data: CacheExport, options?: ImportOptions): void {
      if (options?.strategy === "overwrite") {
        state.cacheMap.clear();
      }
      importEntries(data, options, {
        getCacheEntry: (key) => state.cacheMap.get(key),
        setCacheEntry: (key, entry) => state.cacheMap.set(key, entry),
        notifyObservers: (key, entry) => notifyObservers(key, entry),
        safeStorageOp: (op, operation, key) => storageMgr.safeStorageOp(op, operation, key),
        storage: state.storage,
      });
    },

    // ═══════════════════════════════════════════════════════════════
    // Prefetch
    // ═══════════════════════════════════════════════════════════════

    prefetch<Data, K extends ValidKey>(
      key: K,
      fetcher: Fetcher<Data, K>,
      options?: { force?: boolean },
    ): { promise: Promise<void>; abort: () => void } {
      const hashed = hashKey(key);
      const force = options?.force ?? false;

      // Save fetcher and rawKey for later revalidation (even if cache exists)
      state.fetcherMap.set(hashed, fetcher as (ctx: FetcherCtx<any>) => unknown | Promise<unknown>);
      state.rawKeyMap.set(hashed, key);

      // Non-force: if cache exists, resolve immediately
      if (!force && state.cacheMap.has(hashed)) {
        return { promise: Promise.resolve(), abort: () => {} };
      }

      // Dedupe: if there's already an in-flight request for this key (from useSWR or
      // another prefetch), join it instead of dispatching a new one.
      const existing = state.inflightMap.get(hashed);
      if (existing && !force) {
        return {
          promise: existing.promise.then(() => {}),
          abort: () => {}, // Don't abort shared inflight
        };
      }

      const abortController = new AbortController();
      const ctx: FetcherCtx<K> = {
        rawKey: key,
        hashedKey: hashed,
        signal: abortController.signal,
      };

      const promise = Promise.resolve(fetcher(ctx))
        .then((data) => {
          // Remove from inflightMap on completion (MF-5)
          state.inflightMap.delete(hashed);
          if (abortController.signal.aborted) return;
          const entry: CacheEntry = { data, timestamp: Date.now() };
          state.cacheMap.set(hashed, entry);
          storageMgr.safeStorageOp(state.storage?.set(hashed, entry), "set", hashed);
          notifyObservers(hashed, entry);
        })
        .catch((err) => {
          // Remove from inflightMap on error (MF-5)
          state.inflightMap.delete(hashed);
          // Suppress errors for aborted prefetches
          if (abortController.signal.aborted) return;
          // Log warning in DEV mode but don't throw (prevents unhandled rejection)
          if (isDev()) {
            // eslint-disable-next-line no-console
            console.warn(`[qwik-swr] prefetch failed for key "${hashed}":`, err);
          }
        });

      // Register in inflightMap so useSWR can deduplicate (MF-5)
      state.inflightMap.set(hashed, {
        hashedKey: hashed,
        promise: promise as Promise<unknown>,
        abortController,
        requestId: state.nextRequestId++,
        observerCount: 0,
      });

      return {
        promise,
        abort: () => abortController.abort(),
      };
    },
  };

  return api;
}

// ─── Module Singleton Export ───
export const store = createCacheStore();
