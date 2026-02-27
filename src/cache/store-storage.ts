import type { HashedKey, CacheEntry, CacheStorage } from "../types/index.ts";
import type { StoreState } from "./store-context.ts";
import { isDev, isThenable } from "../utils/env.ts";

// ═══════════════════════════════════════════════════════════════
// Storage Manager — safe storage ops, lazy hydration, initStorage
// ═══════════════════════════════════════════════════════════════

export interface StorageManagerApi {
  safeStorageOp(op: Promise<void> | void, operation: string, key?: HashedKey): void;
  hydrateKey(hashedKey: HashedKey): void | Promise<void>;
  initStorage(storage?: CacheStorage, hydration?: "eager" | "lazy"): Promise<void>;
}

export function createStorageManager(state: StoreState): StorageManagerApi {
  /**
   * Safely execute a fire-and-forget storage operation.
   * Catches async errors and logs a warning in DEV mode.
   */
  function safeStorageOp(op: Promise<void> | void, operation: string, key?: HashedKey): void {
    if (isThenable(op)) {
      (op as Promise<void>).catch((err) => {
        if (isDev()) {
          console.warn(
            `[qwik-swr] storage.${operation} failed${key ? ` for key "${key}"` : ""}:`,
            err,
          );
        }
      });
    }
  }

  /**
   * On-demand hydration: load a key from storage if it's in the lazy index
   * but not yet loaded into cacheMap.
   * Returns a Promise for async storage backends so callers can await hydration.
   */
  function hydrateKey(hashedKey: HashedKey): void | Promise<void> {
    if (!state.storageKeyIndex || !state.storage) return;
    if (!state.storageKeyIndex.has(hashedKey)) return;
    if (state.hydratedKeys.has(hashedKey)) return;

    // Return existing pending hydration (dedup concurrent calls)
    const pending = state.pendingHydrations.get(hashedKey);
    if (pending) return pending;

    // Mark as hydrated eagerly to prevent concurrent calls from
    // reaching storage.get() before pendingHydrations is set.
    state.hydratedKeys.add(hashedKey);

    // CacheStorage.get can return sync or Promise
    const result = state.storage.get(hashedKey);
    if (isThenable(result)) {
      // Async storage
      const promise = (result as Promise<CacheEntry | null>)
        .then((entry) => {
          if (entry) {
            const existing = state.cacheMap.get(hashedKey);
            if (!existing || entry.timestamp > existing.timestamp) {
              state.cacheMap.set(hashedKey, entry as CacheEntry);
            }
          }
          state.pendingHydrations.delete(hashedKey);
        })
        .catch((err) => {
          // Revert hydrated mark so the key can be retried on next access
          state.hydratedKeys.delete(hashedKey);
          state.pendingHydrations.delete(hashedKey);
          if (isDev()) {
            console.warn(
              `[qwik-swr] storage.get failed during hydration for key "${hashedKey}":`,
              err,
            );
          }
        });
      state.pendingHydrations.set(hashedKey, promise);
      return promise;
    }

    // Sync storage: apply immediately
    const entry = result as CacheEntry | null;
    if (entry) {
      const existing = state.cacheMap.get(hashedKey);
      if (!existing || entry.timestamp > existing.timestamp) {
        state.cacheMap.set(hashedKey, entry as CacheEntry);
      }
    }
  }

  async function initStorage(
    storageArg?: CacheStorage,
    hydration?: "eager" | "lazy",
  ): Promise<void> {
    state.storage = storageArg ?? null;
    state.storageKeyIndex = null;
    state.hydratedKeys.clear();
    if (!state.storage) return;

    const mode = hydration ?? "eager";

    if (mode === "lazy") {
      // Lazy: only read key index, defer actual data loading
      const keys = await state.storage.keys();
      state.storageKeyIndex = new Set(keys);
      return;
    }

    // Eager (default): read all entries from storage into cacheMap
    // Timestamp comparison: only set if storage entry is newer than existing
    const keys = await state.storage.keys();
    for (const key of keys) {
      const entry = await state.storage!.get(key);
      if (entry) {
        const existing = state.cacheMap.get(key);
        if (!existing || entry.timestamp > existing.timestamp) {
          state.cacheMap.set(key, entry as CacheEntry);
        }
      }
    }
  }

  return { safeStorageOp, hydrateKey, initStorage };
}
