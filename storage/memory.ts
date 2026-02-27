import type { CacheStorage, CacheEntry, HashedKey } from "../src/types/index.ts";

/**
 * Create an in-memory CacheStorage backed by a Map.
 *
 * @param options.maxSize - When set, oldest entries (by insertion order) are
 *   evicted automatically when the map exceeds this limit.
 */
export function createMemoryStorage(options?: { maxSize?: number }): CacheStorage {
  const maxSize = options?.maxSize;
  const map = new Map<HashedKey, CacheEntry<unknown>>();

  function evictOldest(): void {
    if (maxSize === undefined || map.size <= maxSize) return;
    // Map iteration order is insertion order – first key is the oldest.
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }

  return {
    get<Data>(key: HashedKey): CacheEntry<Data> | null {
      const entry = map.get(key);
      return entry === undefined ? null : (entry as CacheEntry<Data>);
    },

    set<Data>(key: HashedKey, entry: CacheEntry<Data>): void {
      // Delete first so re-insertion moves the key to the end (refreshes order).
      map.delete(key);
      map.set(key, entry as CacheEntry<unknown>);
      evictOldest();
    },

    delete(key: HashedKey): void {
      map.delete(key);
    },

    clear(): void {
      map.clear();
    },

    keys(): HashedKey[] {
      return [...map.keys()];
    },

    size(): number {
      return map.size;
    },
  };
}
