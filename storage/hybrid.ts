import type { CacheStorage, CacheEntry, HashedKey } from "../src/types/index.ts";
import { isDev } from "../src/utils/env.ts";

/**
 * Create a hybrid CacheStorage that combines a fast synchronous memory layer
 * with a slower persistent layer.
 *
 * - **Read-through**: `get` checks memory first; on miss, reads from persistent.
 * - **Write-through**: `set` writes to both memory and persistent.
 * - **delete / clear**: applied to both layers.
 * - **keys**: merged (deduplicated) from both layers.
 * - **size**: returns the memory layer's size (primary / authoritative).
 *
 * Hydration (bulk-loading persistent entries into memory at startup) is
 * intentionally left to `CacheStore.initStorage` so this adapter stays simple.
 */
export function createHybridStorage(config: {
  memory: CacheStorage;
  persistent: CacheStorage;
}): CacheStorage {
  const { memory, persistent } = config;

  return {
    get<Data>(key: HashedKey): CacheEntry<Data> | null | Promise<CacheEntry<Data> | null> {
      const memResult = memory.get<Data>(key);

      // Fast path: synchronous memory hit.
      if (memResult !== null && !(memResult instanceof Promise)) {
        return memResult;
      }

      // If memory.get returned a Promise, chain it.
      if (memResult instanceof Promise) {
        return memResult.then((entry) => {
          if (entry !== null) return entry;
          // Read-through: populate memory layer on persistent hit (SF-16)
          const persistResult = persistent.get<Data>(key);
          if (persistResult instanceof Promise) {
            return persistResult.then((pEntry) => {
              if (pEntry !== null) memory.set(key, pEntry);
              return pEntry;
            });
          }
          if (persistResult !== null) memory.set(key, persistResult);
          return persistResult;
        });
      }

      // memResult === null → fall through to persistent with read-through (SF-16)
      const persistResult = persistent.get<Data>(key);
      if (persistResult instanceof Promise) {
        return persistResult.then((pEntry) => {
          if (pEntry !== null) memory.set(key, pEntry);
          return pEntry;
        });
      }
      if (persistResult !== null) memory.set(key, persistResult);
      return persistResult;
    },

    set<Data>(key: HashedKey, entry: CacheEntry<Data>): void | Promise<void> {
      const memResult = memory.set(key, entry);
      const persistResult = persistent.set(key, entry);

      // If either returns a Promise, await both (log persistent failures - SF-17).
      if (memResult instanceof Promise || persistResult instanceof Promise) {
        return Promise.all([
          memResult,
          persistResult instanceof Promise
            ? persistResult.catch((err) => {
                if (isDev()) {
                  // eslint-disable-next-line no-console
                  console.warn(`[qwik-swr] Persistent storage write failed for key "${key}":`, err);
                }
              })
            : persistResult,
        ]).then(() => {});
      }
    },

    delete(key: HashedKey): void | Promise<void> {
      const memResult = memory.delete(key);
      const persistResult = persistent.delete(key);

      if (memResult instanceof Promise || persistResult instanceof Promise) {
        return Promise.all([memResult, persistResult]).then(() => {});
      }
    },

    clear(): void | Promise<void> {
      const memResult = memory.clear();
      const persistResult = persistent.clear();

      if (memResult instanceof Promise || persistResult instanceof Promise) {
        return Promise.all([memResult, persistResult]).then(() => {});
      }
    },

    keys(): HashedKey[] | Promise<HashedKey[]> {
      const memKeys = memory.keys();
      const persistKeys = persistent.keys();

      if (memKeys instanceof Promise || persistKeys instanceof Promise) {
        return Promise.all([memKeys, persistKeys]).then(([mk, pk]) => [...new Set([...mk, ...pk])]);
      }

      return [...new Set([...(memKeys as HashedKey[]), ...(persistKeys as HashedKey[])])];
    },

    size(): number | Promise<number> {
      return memory.size();
    },
  };
}
