import type {
  HashedKey,
  ValidKey,
  CacheEntry,
  CacheExport,
  ImportOptions,
  CacheStorage,
  DebugSnapshot,
  DebugEntry,
  ResolvedQueryConfig,
} from "../types/index.ts";
import type { InFlightEntry, Observer } from "./types.ts";

// ═══════════════════════════════════════════════════════════════
// Data views for free functions (read-only access to CacheStore internals)
// ═══════════════════════════════════════════════════════════════

export interface StoreDataView {
  cacheMap: ReadonlyMap<HashedKey, CacheEntry>;
  observerRegistry: ReadonlyMap<HashedKey, ReadonlySet<Observer>>;
  queryConfigMap: ReadonlyMap<HashedKey, ResolvedQueryConfig>;
  inflightMap: ReadonlyMap<HashedKey, InFlightEntry>;
}

export interface ImportHandlers {
  getCacheEntry: (key: HashedKey) => CacheEntry | undefined;
  setCacheEntry: (key: HashedKey, entry: CacheEntry) => void;
  notifyObservers: (key: HashedKey, entry: CacheEntry) => void;
  safeStorageOp: (op: Promise<void> | void, operation: string, key?: HashedKey) => void;
  storage: CacheStorage | null;
}

// ═══════════════════════════════════════════════════════════════
// Debug Snapshot
// ═══════════════════════════════════════════════════════════════

export function createDebugSnapshot(data: StoreDataView): DebugSnapshot {
  const now = Date.now();
  const entries: DebugEntry[] = [];
  let totalObservers = 0;

  for (const [hashedKey, cacheEntry] of data.cacheMap) {
    const observers = data.observerRegistry.get(hashedKey);
    const observerCount = observers?.size ?? 0;
    totalObservers += observerCount;

    const cfg = data.queryConfigMap.get(hashedKey);
    const age = now - cacheEntry.timestamp;
    const isInflight = data.inflightMap.has(hashedKey);
    const hasError = cacheEntry.error != null;

    let status: DebugEntry["status"];
    if (isInflight) {
      status = "fetching";
    } else if (hasError) {
      status = "error";
    } else if (cfg && age > cfg.staleTime) {
      status = "stale";
    } else {
      status = "fresh";
    }

    // Get rawKey from first observer
    let rawKey: ValidKey | undefined;
    if (observers && observers.size > 0) {
      const first = observers.values().next().value;
      if (first) rawKey = (first as Observer).lastRawKey;
    }

    entries.push({ hashedKey, rawKey, status, age, observerCount, hasError });
  }

  // Also count observers for keys without cache entries
  for (const [hashedKey, observers] of data.observerRegistry) {
    if (!data.cacheMap.has(hashedKey)) {
      totalObservers += observers.size;
    }
  }

  return {
    entries,
    totalObservers,
    inflightCount: data.inflightMap.size,
  };
}

// ═══════════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════════

export function exportCache(cacheMap: ReadonlyMap<HashedKey, CacheEntry>): CacheExport {
  const entries: CacheExport["entries"] = [];
  for (const [hashedKey, entry] of cacheMap) {
    entries.push({ hashedKey, entry });
  }
  return {
    version: 1,
    exportedAt: Date.now(),
    entries,
  };
}

// ═══════════════════════════════════════════════════════════════
// Import
// ═══════════════════════════════════════════════════════════════

export function importEntries(
  data: CacheExport,
  options: ImportOptions | undefined,
  handlers: ImportHandlers,
): void {
  const strategy = options?.strategy ?? "merge";

  if (strategy === "overwrite") {
    // Clear handled by caller (needs access to cacheMap.clear())
    handlers.safeStorageOp(handlers.storage?.clear(), "clear");
  }

  for (const { hashedKey, entry } of data.entries) {
    if (strategy === "merge") {
      const existing = handlers.getCacheEntry(hashedKey);
      if (existing && existing.timestamp >= entry.timestamp) {
        continue; // keep existing (newer or equal)
      }
    }
    handlers.setCacheEntry(hashedKey, entry);
    handlers.safeStorageOp(handlers.storage?.set(hashedKey, entry), "set", hashedKey);
    handlers.notifyObservers(hashedKey, entry);
  }
}
