import type {
  HashedKey,
  ValidKey,
  SWRKey,
  CacheEntry,
  CacheExport,
  ImportOptions,
  Fetcher,
} from "../types/index.ts";
import { hashKey } from "../utils/hash.ts";
import { store } from "./store.ts";

/**
 * Public cache API for external use.
 *
 * Provides mutate, revalidate, delete, clear, get, and keys operations
 * that delegate to the CacheStore singleton.
 */
export const cache = {
  /**
   * Mutate cache data for a key.
   */
  mutate<Data>(
    key: SWRKey,
    data: Data | ((current: Data | undefined) => Data),
    options?: { revalidate?: boolean },
  ): void {
    if (key === null || key === undefined || key === false) return;
    const hashed = hashKey(key as ValidKey);
    const resolvedData =
      typeof data === "function"
        ? (data as (current: Data | undefined) => Data)(store.getCache<Data>(hashed)?.data)
        : data;
    store.setCache(hashed, { data: resolvedData, timestamp: Date.now() });

    // Trigger revalidation if requested (default: true)
    const shouldRevalidate = options?.revalidate ?? true;
    if (shouldRevalidate) {
      store.revalidateByKey(hashed);
    }
  },

  /**
   * Revalidate cache entries by key or predicate.
   * When a predicate is passed, all matching keys are revalidated.
   */
  revalidate(keyOrFilter: SWRKey | ((key: HashedKey) => boolean)): void {
    if (keyOrFilter === null || keyOrFilter === undefined || keyOrFilter === false) return;

    if (typeof keyOrFilter === "function") {
      // Predicate mode: revalidate all matching keys
      for (const hashedKey of store.keys()) {
        if (keyOrFilter(hashedKey)) {
          store.revalidateByKey(hashedKey);
        }
      }
    } else {
      // Single key mode
      const hashed = hashKey(keyOrFilter as ValidKey);
      store.revalidateByKey(hashed);
    }
  },

  /**
   * Delete cache entry for a key.
   */
  delete(key: SWRKey): void {
    if (key === null || key === undefined || key === false) return;
    const hashed = hashKey(key as ValidKey);
    store.deleteCache(hashed);
  },

  /**
   * Clear all cache entries.
   */
  clear(): void {
    store.clearCache();
  },

  /**
   * Get cache entry for a key.
   */
  get<Data>(key: SWRKey): CacheEntry<Data> | null {
    if (key === null || key === undefined || key === false) return null;
    const hashed = hashKey(key as ValidKey);
    return store.getCache<Data>(hashed);
  },

  /**
   * Get all cached keys.
   */
  keys(): HashedKey[] {
    return store.keys();
  },

  /**
   * Export all cache entries as a serializable snapshot.
   */
  export(): CacheExport {
    return store.export();
  },

  /**
   * Import cache entries from a previously exported snapshot.
   */
  import(data: CacheExport, options?: ImportOptions): void {
    store.import(data, options);
  },

  /**
   * Prefetch data for a key and store it in cache.
   */
  prefetch<Data, K extends ValidKey>(
    key: K,
    fetcher: Fetcher<Data, K>,
    options?: { force?: boolean },
  ): { promise: Promise<void>; abort: () => void } {
    return store.prefetch(key, fetcher, options);
  },
};
