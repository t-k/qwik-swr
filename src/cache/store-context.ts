import type {
  HashedKey,
  ValidKey,
  CacheEntry,
  ResolvedQueryConfig,
  FetcherCtx,
  CacheStorage,
} from "../types/index.ts";
import type { InFlightEntry, CooldownRecord, Observer } from "./types.ts";
import type { SyncChannelApi } from "./sync-channel.ts";
import type { NotificationSchedulerApi } from "./notification-scheduler.ts";

// ═══════════════════════════════════════════════════════════════
// Shared mutable state — replaces closure variables in createCacheStore
// ═══════════════════════════════════════════════════════════════

export interface StoreState {
  // Collections (reference types — readonly means "don't reassign", contents are mutable)
  readonly cacheMap: Map<HashedKey, CacheEntry>;
  readonly inflightMap: Map<HashedKey, InFlightEntry>;
  readonly cooldownMap: Map<HashedKey, CooldownRecord>;
  readonly queryConfigMap: Map<HashedKey, ResolvedQueryConfig>;
  readonly observerRegistry: Map<HashedKey, Set<Observer>>;
  readonly latestRequestId: Map<HashedKey, number>;
  readonly fetcherMap: Map<HashedKey, (ctx: FetcherCtx<any>) => unknown | Promise<unknown>>;
  readonly rawKeyMap: Map<HashedKey, ValidKey>;
  readonly pendingKeys: Set<HashedKey>;
  readonly hydratedKeys: Set<HashedKey>;
  readonly pendingHydrations: Map<HashedKey, Promise<void>>;
  readonly remoteInflight: Map<HashedKey, ReturnType<typeof setTimeout>>;

  // Primitives (on object for reference semantics)
  nextRequestId: number;
  isOnline: boolean;
  dedupEnabled: boolean;
  dedupTimeout: number;
  storage: CacheStorage | null;
  syncChannel: SyncChannelApi | null;
  scheduler: NotificationSchedulerApi | null;
  storageKeyIndex: Set<HashedKey> | null;
}

export function createStoreState(): StoreState {
  return {
    cacheMap: new Map(),
    inflightMap: new Map(),
    cooldownMap: new Map(),
    queryConfigMap: new Map(),
    observerRegistry: new Map(),
    latestRequestId: new Map(),
    fetcherMap: new Map(),
    rawKeyMap: new Map(),
    pendingKeys: new Set(),
    hydratedKeys: new Set(),
    pendingHydrations: new Map(),
    remoteInflight: new Map(),

    nextRequestId: 1,
    isOnline: typeof navigator !== "undefined" && "onLine" in navigator ? navigator.onLine : true,
    dedupEnabled: false,
    dedupTimeout: 30_000,
    storage: null,
    syncChannel: null,
    scheduler: null,
    storageKeyIndex: null,
  };
}
