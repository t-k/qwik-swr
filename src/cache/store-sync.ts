import type { HashedKey, CacheEntry, SyncMessage } from "../types/index.ts";
import type { Observer } from "./types.ts";
import type { StoreState } from "./store-context.ts";

// ═══════════════════════════════════════════════════════════════
// Sync Handler — cross-tab sync message processing + dedup
// ═══════════════════════════════════════════════════════════════

export interface SyncHandlerDeps {
  notifyObservers: (key: HashedKey, entry: CacheEntry) => void;
  safeStorageOp: (op: Promise<void> | void, operation: string, key?: HashedKey) => void;
}

export interface SyncHandlerApi {
  handleSyncMessage(msg: SyncMessage): void;
  enableDedup(enabled: boolean, timeout?: number): void;
}

export function createSyncHandler(state: StoreState, deps: SyncHandlerDeps): SyncHandlerApi {
  function clearRemoteInflightTimer(key: HashedKey): void {
    const timerId = state.remoteInflight.get(key);
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
    state.remoteInflight.delete(key);
  }

  function addRemoteInflight(key: HashedKey): void {
    // Clear any existing timer for this key first
    clearRemoteInflightTimer(key);
    const timerId = setTimeout(() => {
      state.remoteInflight.delete(key);
    }, state.dedupTimeout);
    state.remoteInflight.set(key, timerId);
  }

  function handleSyncMessage(msg: SyncMessage): void {
    // Subscription sync messages are handled by SubscriptionRegistry
    if (msg.type.startsWith("sub-")) return;

    switch (msg.type) {
      case "set": {
        // Last-writer-wins: only apply if remote entry is newer
        const existing = state.cacheMap.get(msg.key);
        if (existing && existing.timestamp > msg.entry.timestamp) {
          return; // local is strictly newer
        }
        state.cacheMap.set(msg.key, msg.entry);
        // Persist to storage (do NOT broadcast again — avoid echo loop)
        deps.safeStorageOp(state.storage?.set(msg.key, msg.entry), "set", msg.key);
        deps.notifyObservers(msg.key, msg.entry);
        break;
      }
      case "delete": {
        state.cacheMap.delete(msg.key);
        deps.safeStorageOp(state.storage?.delete(msg.key), "delete", msg.key);
        // Notify observers with cleared data
        const set = state.observerRegistry.get(msg.key);
        if (set) {
          for (const ob of set as Set<Observer>) {
            ob.hasData = false;
            ob.onData({ data: undefined, timestamp: 0 });
          }
        }
        break;
      }
      case "clear": {
        state.cacheMap.clear();
        deps.safeStorageOp(state.storage?.clear(), "clear");
        break;
      }
      case "fetch-start": {
        if (state.dedupEnabled) {
          addRemoteInflight(msg.key);
        }
        break;
      }
      case "fetch-complete": {
        clearRemoteInflightTimer(msg.key);
        // Apply fetched data to local cache (last-writer-wins)
        const existingComplete = state.cacheMap.get(msg.key);
        if (!existingComplete || msg.entry.timestamp > existingComplete.timestamp) {
          state.cacheMap.set(msg.key, msg.entry);
          deps.safeStorageOp(state.storage?.set(msg.key, msg.entry), "set", msg.key);
          deps.notifyObservers(msg.key, msg.entry);
        }
        break;
      }
      case "fetch-error": {
        clearRemoteInflightTimer(msg.key);
        break;
      }
      default:
        break;
    }
  }

  function enableDedup(enabled: boolean, timeout?: number): void {
    state.dedupEnabled = enabled;
    if (timeout !== undefined) {
      state.dedupTimeout = timeout;
    }
    if (!enabled) {
      for (const [, timerId] of state.remoteInflight) {
        clearTimeout(timerId);
      }
      state.remoteInflight.clear();
    }
  }

  return { handleSyncMessage, enableDedup };
}
