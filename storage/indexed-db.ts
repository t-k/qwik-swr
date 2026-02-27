import type { CacheStorage, CacheEntry, HashedKey } from "../src/types/index.ts";
import { toStorable } from "./utils.ts";
import { isDev } from "../src/utils/env.ts";

/**
 * Create a no-op async CacheStorage for SSR environments.
 */
function createNoopStorage(): CacheStorage {
  return {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    clear: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
    size: () => Promise.resolve(0),
  };
}

/**
 * Create a CacheStorage backed by IndexedDB.
 *
 * @param options.dbName    - Database name. Default: `"qwik-swr"`.
 * @param options.storeName - Object store name. Default: `"cache"`.
 * @param options.maxSize   - Maximum number of entries. When exceeded, new
 *   `set` calls are silently skipped (with a `console.warn` in DEV mode).
 */
export function createIndexedDBStorage(options?: {
  dbName?: string;
  storeName?: string;
  maxSize?: number;
}): CacheStorage {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    return createNoopStorage();
  }

  const dbName = options?.dbName ?? "qwik-swr";
  const storeName = options?.storeName ?? "cache";
  const maxSize = options?.maxSize;

  const DB_OPEN_TIMEOUT_MS = 5_000;
  let dbPromise: Promise<IDBDatabase> | null = null;

  /** Lazily open (or create) the database with a timeout guard. */
  function getDB(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const timer = setTimeout(() => {
        dbPromise = null; // Reset so next call retries
        reject(new Error(`[qwik-swr] IndexedDB open timed out after ${DB_OPEN_TIMEOUT_MS}ms`));
      }, DB_OPEN_TIMEOUT_MS);

      const request = indexedDB.open(dbName, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };

      request.onsuccess = () => {
        clearTimeout(timer);
        resolve(request.result);
      };
      request.onerror = () => {
        clearTimeout(timer);
        dbPromise = null; // Reset so next call retries (MF-9)
        reject(request.error);
      };
    });
    return dbPromise;
  }

  /** Helper: wrap an IDBRequest in a Promise. */
  function req<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** Helper: open a transaction and return the object store. */
  async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await getDB();
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  return {
    async get<Data>(key: HashedKey): Promise<CacheEntry<Data> | null> {
      try {
        const s = await store("readonly");
        const value = await req(s.get(key));
        return value === undefined ? null : (value as CacheEntry<Data>);
      } catch {
        return null;
      }
    },

    async set<Data>(key: HashedKey, entry: CacheEntry<Data>): Promise<void> {
      try {
        // Use a single readwrite transaction for atomic maxSize check + write (MF-10)
        const s = await store("readwrite");
        if (maxSize !== undefined) {
          const existing = await req(s.get(key));
          if (existing === undefined) {
            const count = await req(s.count());
            if (count >= maxSize) {
              if (isDev()) {
                console.warn(
                  `[qwik-swr] IndexedDB maxSize (${maxSize}) exceeded – skipping set for key "${key}"`,
                );
              }
              return;
            }
          }
        }
        await req(s.put(toStorable(entry), key));
      } catch {
        if (isDev()) {
          console.warn(`[qwik-swr] IndexedDB set failed for key "${key}"`);
        }
      }
    },

    async delete(key: HashedKey): Promise<void> {
      try {
        const s = await store("readwrite");
        await req(s.delete(key));
      } catch {
        // silently ignore
      }
    },

    async clear(): Promise<void> {
      try {
        const s = await store("readwrite");
        await req(s.clear());
      } catch {
        // silently ignore
      }
    },

    async keys(): Promise<HashedKey[]> {
      try {
        const s = await store("readonly");
        return (await req(s.getAllKeys())) as HashedKey[];
      } catch {
        return [];
      }
    },

    async size(): Promise<number> {
      try {
        const s = await store("readonly");
        return await req(s.count());
      } catch {
        return 0;
      }
    },
  };
}
