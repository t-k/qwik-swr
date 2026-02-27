import type { QRL } from "@builder.io/qwik";

// ═══════════════════════════════════════════════════════════════
// Key Types
// ═══════════════════════════════════════════════════════════════

export type KeyAtom = string | number | boolean | null;
export type SWRKey = string | readonly KeyAtom[] | null | undefined | false;
export type ValidKey = Exclude<SWRKey, null | undefined | false>;
export type HashedKey = string;

// ═══════════════════════════════════════════════════════════════
// Fetcher Context
// ═══════════════════════════════════════════════════════════════

export interface FetcherCtx<K extends ValidKey = ValidKey> {
  rawKey: K;
  hashedKey: HashedKey;
  signal: AbortSignal;
}

export type Fetcher<Data, K extends ValidKey = ValidKey> = (
  ctx: FetcherCtx<K>,
) => Data | Promise<Data>;

// ═══════════════════════════════════════════════════════════════
// Error Types
// ═══════════════════════════════════════════════════════════════

export type SWRErrorType =
  | "network"
  | "http"
  | "parse"
  | "timeout"
  | "abort"
  | "business"
  | "unknown";

export interface SWRError {
  type: SWRErrorType;
  status?: number;
  message: string;
  retryCount: number;
  timestamp: number;
  stack?: string;
  /** Non-serializable: memory only. Excluded during persistence. */
  original?: unknown;
}

export type SerializableSWRError = Omit<SWRError, "original">;

// ═══════════════════════════════════════════════════════════════
// Cache Types
// ═══════════════════════════════════════════════════════════════

export interface CacheEntry<Data = unknown> {
  data: Data | undefined;
  timestamp: number;
  error?: SerializableSWRError;
}

export interface CacheStorage {
  get<Data>(key: HashedKey): CacheEntry<Data> | null | Promise<CacheEntry<Data> | null>;
  set<Data>(key: HashedKey, entry: CacheEntry<Data>): void | Promise<void>;
  delete(key: HashedKey): void | Promise<void>;
  clear(): void | Promise<void>;
  keys(): HashedKey[] | Promise<HashedKey[]>;
  size(): number | Promise<number>;
}

// ═══════════════════════════════════════════════════════════════
// Status Types
// ═══════════════════════════════════════════════════════════════

export type Status = "idle" | "loading" | "success" | "error";
export type FetchStatus = "idle" | "fetching" | "paused";
export type Eagerness = "visible" | "load" | "idle";

// ═══════════════════════════════════════════════════════════════
// Freshness Presets
// ═══════════════════════════════════════════════════════════════

export type FreshnessPreset = "volatile" | "eager" | "fast" | "normal" | "slow" | "static";

export type RevalidateTrigger = "focus" | "reconnect" | "interval";

export interface FreshnessConfig {
  staleTime: number;
  cacheTime: number;
  dedupingInterval: number;
}

/** Freshness preset configurations. Uses Number.MAX_SAFE_INTEGER instead of Infinity for JSON.stringify compatibility. */
export const FRESHNESS_PRESETS: Record<FreshnessPreset, FreshnessConfig> = {
  volatile: { staleTime: 0, cacheTime: 0, dedupingInterval: 2_000 },
  eager: { staleTime: 0, cacheTime: 30_000, dedupingInterval: 2_000 },
  fast: { staleTime: 10_000, cacheTime: 60_000, dedupingInterval: 5_000 },
  normal: { staleTime: 30_000, cacheTime: 300_000, dedupingInterval: 5_000 },
  slow: { staleTime: 300_000, cacheTime: 3_600_000, dedupingInterval: 30_000 },
  static: {
    staleTime: Number.MAX_SAFE_INTEGER,
    cacheTime: Number.MAX_SAFE_INTEGER,
    dedupingInterval: Number.MAX_SAFE_INTEGER,
  },
};

// ═══════════════════════════════════════════════════════════════
// Options
// ═══════════════════════════════════════════════════════════════

/** Shared optional fields between SWRConfig (global) and SWROptions (per-hook). */
export interface CommonSWROptions {
  freshness?: FreshnessPreset;
  staleTime?: number;
  cacheTime?: number;
  revalidateOn?: RevalidateTrigger[];
  refreshInterval?: number;
  dedupingInterval?: number;
  retry?: boolean | number;
  retryInterval?: number | ((retryCount: number, error: SWRError) => number);
  timeout?: number;
  eagerness?: Eagerness;
}

export interface SWROptions<Data = unknown> extends CommonSWROptions {
  fallbackData?: Data;
  enabled?: boolean;
  onSuccess$?: QRL<(data: Data, key: ValidKey) => void>;
  onError$?: QRL<(error: SWRError, key: ValidKey) => void>;
}

/** Resolved options with all values filled in (no undefined). */
export interface ResolvedSWROptions<Data = unknown> {
  fallbackData?: Data;
  enabled: boolean;
  eagerness: Eagerness;
  staleTime: number;
  cacheTime: number;
  revalidateOn: RevalidateTrigger[];
  refreshInterval: number;
  dedupingInterval: number;
  retry: number;
  retryInterval: number | ((retryCount: number, error: SWRError) => number);
  timeout: number;
  onSuccess$?: QRL<(data: Data, key: ValidKey) => void>;
  onError$?: QRL<(error: SWRError, key: ValidKey) => void>;
}

/** Internal: ResolvedSWROptions + provider-level fields used by CacheStore. */
export interface ResolvedQueryConfig<Data = unknown> extends ResolvedSWROptions<Data> {
  onErrorGlobal$?: QRL<(error: SWRError, key: ValidKey) => void>;
}

// ═══════════════════════════════════════════════════════════════
// Response Types
// ═══════════════════════════════════════════════════════════════

export interface SWRResponse<Data> {
  data: Data | undefined;
  error: SWRError | undefined;
  status: Status;
  fetchStatus: FetchStatus;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isValidating: boolean;
  isStale: boolean;
  revalidate$: QRL<() => Promise<Data | undefined>>;
  mutate$: QRL<
    (
      data: Data | ((current: Data | undefined) => Data),
      options?: { revalidate?: boolean },
    ) => Promise<void>
  >;
}

// ═══════════════════════════════════════════════════════════════
// Global Config
// ═══════════════════════════════════════════════════════════════

export interface SWRConfig extends CommonSWROptions {
  onErrorGlobal$?: QRL<(error: SWRError, key: ValidKey) => void>;
}

// ═══════════════════════════════════════════════════════════════
// Mutation Types (Phase 2)
// ═══════════════════════════════════════════════════════════════

export type MutationStatus = "idle" | "pending" | "success" | "error";

export interface OptimisticUpdateConfig<Data = unknown, Variables = void> {
  key: SWRKey;
  updater$: QRL<(current: Data | undefined, variables: Variables) => Data>;
}

export interface MutationOptions<Data = unknown, Variables = void> {
  optimisticUpdate?: OptimisticUpdateConfig<Data, Variables>;
  invalidateKeys?: SWRKey[];
  onSuccess$?: QRL<(data: Data, variables: Variables) => void>;
  onError$?: QRL<(error: SWRError, variables: Variables) => void>;
}

export interface MutationResponse<Data = unknown, Variables = void> {
  mutate$: QRL<(variables: Variables) => void>;
  mutateAsync$: QRL<(variables: Variables) => Promise<Data>>;
  reset$: QRL<() => void>;
  data: Data | undefined;
  error: SWRError | undefined;
  variables: Variables | undefined;
  isIdle: boolean;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Subscription Types (Phase 2)
// ═══════════════════════════════════════════════════════════════

export type SubscriptionStatus = "connecting" | "live" | "disconnected";

export type Subscriber<Data, K extends ValidKey = ValidKey> = (
  key: K,
  callbacks: {
    onData: (data: Data) => void;
    onError: (error: Error | SWRError) => void;
  },
) => { unsubscribe: () => void } | Promise<{ unsubscribe: () => void }>;

export interface SubscriptionOptions<Data = unknown> {
  maxRetries?: number;
  retryInterval?: number;
  /** Timeout (ms) for initial connection. If status stays "connecting" beyond this, treat as error and retry. Default: 30000 */
  connectionTimeout?: number;
  onData$?: QRL<(data: Data) => void>;
  onError$?: QRL<(error: SWRError) => void>;
  onStatusChange$?: QRL<(status: SubscriptionStatus) => void>;
}

export interface SubscriptionResponse<Data = unknown> {
  data: Data | undefined;
  error: SWRError | undefined;
  status: SubscriptionStatus;
  isConnecting: boolean;
  isLive: boolean;
  isDisconnected: boolean;
  unsubscribe$: QRL<() => void>;
  reconnect$: QRL<() => void>;
}

// ═══════════════════════════════════════════════════════════════
// Devtools / Export / Import Types (Phase 4)
// ═══════════════════════════════════════════════════════════════

export interface CacheExport {
  version: 1;
  exportedAt: number;
  entries: Array<{ hashedKey: HashedKey; entry: CacheEntry }>;
}

export interface ImportOptions {
  strategy?: "merge" | "overwrite";
}

export interface DebugEntry {
  hashedKey: HashedKey;
  rawKey?: ValidKey;
  status: "fresh" | "stale" | "fetching" | "error";
  age: number;
  observerCount: number;
  hasError: boolean;
}

export interface DebugSnapshot {
  entries: DebugEntry[];
  totalObservers: number;
  inflightCount: number;
}

// ═══════════════════════════════════════════════════════════════
// GC Types (Phase 4 + Phase 6 extensions)
// ═══════════════════════════════════════════════════════════════

export interface GCConfig {
  intervalMs?: number;
  enabled?: boolean;
  /** Cache entry count limit (undefined = unlimited) */
  maxEntries?: number;
  /** Adjust threshold based on navigator.deviceMemory (default: false) */
  memoryAware?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Sync Types (Phase 6: Cross-tab sync)
// ═══════════════════════════════════════════════════════════════

/** Cross-tab sync configuration */
export interface SyncConfig {
  /** Enable/disable cross-tab sync (default: true) */
  enabled?: boolean;
  /** BroadcastChannel name (default: 'qwik-swr') */
  channelName?: string;
  /** Enable cross-tab fetch dedup (default: false) */
  dedup?: boolean;
  /** Timeout for cross-tab fetch dedup in ms (default: 30000).
   *  If a remote tab doesn't complete its fetch within this time,
   *  local tabs will resume fetching. */
  dedupTimeout?: number;
  /** Enable subscription data sync across tabs (default: false) */
  subscriptionSync?: boolean;
  /** Enable subscription connection dedup via leader election (default: false) */
  subscriptionDedup?: boolean;
  /** Leader heartbeat interval in ms (default: 3000) */
  heartbeatInterval?: number;
  /** Follower failover timeout in ms (default: 10000) */
  failoverTimeout?: number;
  /** Custom SharedWorker URL for CSP-strict environments */
  subscriptionWorkerUrl?: string;
}

/** All known sync message type strings */
export type SyncMessageType =
  | "set"
  | "delete"
  | "clear"
  | "fetch-start"
  | "fetch-complete"
  | "fetch-error"
  | "sub-data"
  | "sub-status"
  | "sub-error"
  | "sub-leader-claim"
  | "sub-leader-heartbeat"
  | "sub-leader-resign";

/** Cross-tab sync message */
export type SyncMessage =
  | {
      version: 1;
      type: "set";
      tabId: string;
      key: HashedKey;
      entry: CacheEntry;
      timestamp: number;
    }
  | {
      version: 1;
      type: "delete";
      tabId: string;
      key: HashedKey;
      timestamp: number;
    }
  | {
      version: 1;
      type: "clear";
      tabId: string;
      timestamp: number;
    }
  | {
      version: 1;
      type: "fetch-start";
      tabId: string;
      key: HashedKey;
      timestamp: number;
    }
  | {
      version: 1;
      type: "fetch-complete";
      tabId: string;
      key: HashedKey;
      entry: CacheEntry;
      timestamp: number;
    }
  | {
      version: 1;
      type: "fetch-error";
      tabId: string;
      key: HashedKey;
      error: SerializableSWRError;
      timestamp: number;
    }
  | {
      version: 1;
      type: "sub-data";
      tabId: string;
      key: HashedKey;
      data: unknown;
      timestamp: number;
    }
  | {
      version: 1;
      type: "sub-status";
      tabId: string;
      key: HashedKey;
      status: SubscriptionStatus;
      timestamp: number;
    }
  | {
      version: 1;
      type: "sub-error";
      tabId: string;
      key: HashedKey;
      error: SerializableSWRError;
      timestamp: number;
    }
  | {
      version: 1;
      type: "sub-leader-claim";
      tabId: string;
      key: HashedKey;
      timestamp: number;
    }
  | {
      version: 1;
      type: "sub-leader-heartbeat";
      tabId: string;
      key: HashedKey;
      timestamp: number;
    }
  | {
      version: 1;
      type: "sub-leader-resign";
      tabId: string;
      key: HashedKey;
      timestamp: number;
    };

// ═══════════════════════════════════════════════════════════════
// Batching Types (Phase 6: Performance optimizations)
// ═══════════════════════════════════════════════════════════════

/** Observer notification / storage write batching configuration */
export interface BatchingConfig {
  /** Observer notification batch interval. 0=microtask (default: 0) */
  notifyInterval?: number;
  /** Storage write flush interval in ms (default: 50) */
  storageFlushInterval?: number;
}

// ═══════════════════════════════════════════════════════════════
// Init Types (Phase 6)
// ═══════════════════════════════════════════════════════════════

/** initSWR options (named version of the previous inline type) */
export interface InitOptions {
  /** Storage backend */
  storage?: CacheStorage;
  /** GC configuration */
  gc?: GCConfig;
  /** Cross-tab sync configuration */
  sync?: SyncConfig;
  /** Batching configuration */
  batching?: BatchingConfig;
  /**
   * Storage hydration mode
   * - 'eager': Load all entries from storage at startup (current behavior)
   * - 'lazy': Load entries on-demand when first accessed
   */
  hydration?: "eager" | "lazy";
}
