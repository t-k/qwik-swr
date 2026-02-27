import type { CacheStorage, CacheEntry, HashedKey } from "../src/types/index.ts";
import { toStorable } from "./utils.ts";
import { isDev } from "../src/utils/env.ts";

/**
 * Create a no-op CacheStorage for SSR environments where window is unavailable.
 */
function createNoopStorage(): CacheStorage {
  return {
    get: () => null,
    set: () => {},
    delete: () => {},
    clear: () => {},
    keys: () => [],
    size: () => 0,
  };
}

/**
 * Create a CacheStorage backed by `window.localStorage`.
 *
 * @param options.prefix  - Key prefix used in localStorage. Default: `"swr:"`.
 * @param options.maxSize - Maximum number of entries to store. When exceeded,
 *   new `set` calls are silently skipped (with a `console.warn` in DEV mode).
 */
export function createLocalStorage(options?: { prefix?: string; maxSize?: number }): CacheStorage {
  if (typeof window === "undefined") {
    return createNoopStorage();
  }

  const prefix = options?.prefix ?? "swr:";
  const maxSize = options?.maxSize;

  /** Return the prefixed key used in localStorage. */
  function prefixed(key: HashedKey): string {
    return `${prefix}${key}`;
  }

  // In-memory cache of own keys to avoid O(n) localStorage scan on every operation.
  // Initialized lazily on first access, then maintained incrementally.
  let keyCache: Set<HashedKey> | null = null;

  /** Scan localStorage once and cache the result. */
  function ensureKeyCache(): Set<HashedKey> {
    if (keyCache !== null) return keyCache;
    keyCache = new Set<HashedKey>();
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k !== null && k.startsWith(prefix)) {
        keyCache.add(k.slice(prefix.length) as HashedKey);
      }
    }
    return keyCache;
  }

  /** Return cached own keys as an array. */
  function ownKeys(): HashedKey[] {
    return [...ensureKeyCache()];
  }

  return {
    get<Data>(key: HashedKey): CacheEntry<Data> | null {
      try {
        const raw = window.localStorage.getItem(prefixed(key));
        if (raw === null) return null;
        return JSON.parse(raw) as CacheEntry<Data>;
      } catch {
        return null;
      }
    },

    set<Data>(key: HashedKey, entry: CacheEntry<Data>): void {
      // Check maxSize before writing (existing key updates are always allowed).
      if (maxSize !== undefined) {
        const cache = ensureKeyCache();
        if (!cache.has(key) && cache.size >= maxSize) {
          if (isDev()) {
            console.warn(
              `[qwik-swr] localStorage maxSize (${maxSize}) exceeded – skipping set for key "${key}"`,
            );
          }
          return;
        }
      }

      try {
        window.localStorage.setItem(prefixed(key), JSON.stringify(toStorable(entry)));
        ensureKeyCache().add(key);
      } catch {
        // QuotaExceededError or similar – silently ignore, warn in DEV.
        if (isDev()) {
          console.warn(
            `[qwik-swr] localStorage.setItem failed for key "${key}" (likely QuotaExceededError)`,
          );
        }
      }
    },

    delete(key: HashedKey): void {
      window.localStorage.removeItem(prefixed(key));
      ensureKeyCache().delete(key);
    },

    clear(): void {
      // Only remove our own prefixed keys.
      const keysToRemove = ownKeys();
      for (const k of keysToRemove) {
        window.localStorage.removeItem(prefixed(k));
      }
      keyCache = new Set();
    },

    keys(): HashedKey[] {
      return ownKeys();
    },

    size(): number {
      return ensureKeyCache().size;
    },
  };
}
