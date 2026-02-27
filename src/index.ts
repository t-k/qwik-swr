// Types
export type {
  KeyAtom,
  SWRKey,
  ValidKey,
  HashedKey,
  FetcherCtx,
  Fetcher,
  SWRErrorType,
  SWRError,
  SerializableSWRError,
  CacheEntry,
  CacheStorage,
  Status,
  FetchStatus,
  Eagerness,
  FreshnessPreset,
  FreshnessConfig,
  RevalidateTrigger,
  CommonSWROptions,
  SWROptions,
  ResolvedSWROptions,
  SWRResponse,
  SWRConfig,
  // Phase 2: Mutation
  MutationStatus,
  MutationOptions,
  MutationResponse,
  OptimisticUpdateConfig,
  // Phase 2: Subscription
  SubscriptionStatus,
  Subscriber,
  SubscriptionOptions,
  SubscriptionResponse,
  // Phase 4: Devtools / Export / Import
  CacheExport,
  ImportOptions,
  DebugEntry,
  DebugSnapshot,
  // Phase 4: GC
  GCConfig,
  // Phase 6: Cross-tab sync & performance
  SyncConfig,
  SyncMessage,
  BatchingConfig,
  InitOptions,
} from "./types/index.ts";

// Constants
export { FRESHNESS_PRESETS } from "./types/index.ts";

// Utilities
export { hashKey } from "./utils/hash.ts";
export { toSWRError, serializeSWRError } from "./utils/error.ts";

// Event Manager
export {
  initEventManager,
  registerEventHandler,
  _getSubscriberCounts,
} from "./cache/event-manager.ts";

// Provider
export { SWRProvider, SWRConfigContext } from "./provider/swr-provider.tsx";

// Init
export { initSWR } from "./init.ts";

// Hooks
export { useSWR } from "./hooks/use-swr.ts";
export { useMutation } from "./hooks/use-mutation.ts";

// Cache API
export { cache } from "./cache/cache-api.ts";

// GC
export { startGC, stopGC, runGC } from "./cache/gc.ts";

// Teardown
export { teardownSWR } from "./teardown.ts";
