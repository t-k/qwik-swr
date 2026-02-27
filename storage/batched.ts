import type { CacheEntry, CacheStorage, HashedKey } from "../src/types/index.ts";

/** Batched storage configuration */
export interface BatchedStorageConfig {
  /** Flush interval in ms (default: 50) */
  flushInterval?: number;
}

/**
 * Wrap a CacheStorage with batched writes.
 *
 * Accumulates set/delete/clear operations and flushes them at the configured interval.
 * Flush order: clear -> deletes -> writes.
 * Same-key writes are deduped (latest wins).
 */
export function createBatchedStorage(
  baseStorage: CacheStorage,
  config?: BatchedStorageConfig,
): CacheStorage & {
  /** Force flush all pending writes */
  flush(): Promise<void>;
  /** Dispose: flush + remove event listeners + stop timer */
  dispose(): void;
} {
  const flushInterval = config?.flushInterval ?? 50;

  const pendingWrites = new Map<HashedKey, CacheEntry>();
  const pendingDeletes = new Set<HashedKey>();
  let pendingClear = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let activeFlush: Promise<void> | null = null;

  function scheduleFlush(): void {
    if (timerId !== null) return;
    timerId = setTimeout(() => {
      timerId = null;
      void doFlush();
    }, flushInterval);
  }

  function doFlush(): void | Promise<void> {
    // Snapshot and clear pending state
    const hasClear = pendingClear;
    const deletes = [...pendingDeletes];
    const writes = [...pendingWrites.entries()];
    pendingClear = false;
    pendingDeletes.clear();
    pendingWrites.clear();

    if (!hasClear && deletes.length === 0 && writes.length === 0) {
      return;
    }

    // Execute in sequential order: clear -> deletes -> writes (MF-11)
    // Chain operations to guarantee ordering with async backends
    let chain: void | Promise<void> = undefined;

    if (hasClear) {
      chain = baseStorage.clear();
    }

    for (const key of deletes) {
      if (chain instanceof Promise) {
        chain = chain.then(() => baseStorage.delete(key));
      } else {
        chain = baseStorage.delete(key);
      }
    }

    for (const [key, entry] of writes) {
      if (chain instanceof Promise) {
        chain = chain.then(() => baseStorage.set(key, entry));
      } else {
        chain = baseStorage.set(key, entry);
      }
    }

    return chain;
  }

  /**
   * Trigger a flush. For synchronous base storage this completes immediately.
   * For async base storage the returned Promise tracks completion.
   */
  function triggerFlush(): void | Promise<void> {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    const result = doFlush();
    if (result instanceof Promise) {
      activeFlush = result.finally(() => {
        activeFlush = null;
      });
      return activeFlush;
    }
  }

  // beforeunload: best-effort flush (sync storage completes, async fire-and-forget)
  const onBeforeUnload = () => {
    triggerFlush();
  };

  if (typeof globalThis !== "undefined" && typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("beforeunload", onBeforeUnload);
  }

  function mergeKeys(baseKeys: HashedKey[]): HashedKey[] {
    const result = new Set<HashedKey>();
    for (const k of baseKeys) {
      if (!pendingDeletes.has(k)) {
        result.add(k);
      }
    }
    for (const k of pendingWrites.keys()) {
      result.add(k);
    }
    return [...result];
  }

  return {
    // Read operations check pending writes first (read-your-writes, SF-18)
    get<Data>(key: HashedKey) {
      // Check if key was cleared or deleted
      if (pendingClear && !pendingWrites.has(key)) {
        return null as CacheEntry<Data> | null;
      }
      if (pendingDeletes.has(key)) {
        return null as CacheEntry<Data> | null;
      }
      // Return pending write if exists
      const pending = pendingWrites.get(key);
      if (pending !== undefined) {
        return pending as CacheEntry<Data>;
      }
      return baseStorage.get<Data>(key);
    },

    keys() {
      if (pendingClear) {
        // After clear, only pending writes exist
        return [...pendingWrites.keys()];
      }
      const baseKeys = baseStorage.keys();
      // Handle async baseStorage
      if (baseKeys instanceof Promise) {
        return baseKeys.then((bk) => mergeKeys(bk));
      }
      return mergeKeys(baseKeys);
    },

    size() {
      const k = this.keys();
      if (k instanceof Promise) {
        return k.then((keys) => keys.length);
      }
      return k.length;
    },

    // Write operations are batched
    set<Data>(key: HashedKey, entry: CacheEntry<Data>) {
      pendingWrites.set(key, entry as CacheEntry);
      pendingDeletes.delete(key); // Cancel pending delete for same key
      scheduleFlush();
    },

    delete(key: HashedKey) {
      pendingDeletes.add(key);
      pendingWrites.delete(key); // Cancel pending write for same key
      scheduleFlush();
    },

    clear() {
      pendingClear = true;
      pendingWrites.clear();
      pendingDeletes.clear();
      scheduleFlush();
    },

    async flush(): Promise<void> {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      // Wait for any in-progress flush before starting a new one
      if (activeFlush) await activeFlush;
      await doFlush();
    },

    dispose(): void {
      triggerFlush();
      if (
        typeof globalThis !== "undefined" &&
        typeof globalThis.removeEventListener === "function"
      ) {
        globalThis.removeEventListener("beforeunload", onBeforeUnload);
      }
    },
  };
}
