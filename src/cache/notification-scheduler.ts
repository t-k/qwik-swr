import type { CacheEntry, HashedKey, SWRError } from "../types/index.ts";

/** Observer shape expected by the scheduler */
export interface SchedulerObserver {
  onData: (entry: CacheEntry) => void;
  onError: (error: SWRError) => void;
  onFetchStatusChange: (status: "fetching" | "idle" | "paused") => void;
  hasData: boolean;
}

/** Notification scheduler API */
export interface NotificationSchedulerApi {
  enqueueData(hashedKey: HashedKey, entry: CacheEntry): void;
  enqueueError(hashedKey: HashedKey, error: SWRError): void;
  enqueueFetchStatus(hashedKey: HashedKey, status: "fetching" | "idle" | "paused"): void;
  /** Force immediate flush of all pending notifications (for tests) */
  flush(): void;
  /** Clear all pending state (for tests) */
  _reset(): void;
}

/**
 * Create a notification scheduler that batches observer notifications.
 *
 * @param interval - Batch interval: 0 = queueMicrotask, >0 = setTimeout(ms)
 * @param getObservers - Returns observers for a given key
 */
export function createNotificationScheduler(
  interval: number,
  getObservers: (key: HashedKey) => ReadonlySet<SchedulerObserver> | undefined,
): NotificationSchedulerApi {
  // Per-key pending notifications (last value wins for same key)
  const pendingData = new Map<HashedKey, CacheEntry>();
  const pendingErrors = new Map<HashedKey, SWRError>();
  const pendingFetchStatus = new Map<HashedKey, "fetching" | "idle" | "paused">();
  let scheduled = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  function doFlush(): void {
    scheduled = false;
    timerId = null;

    // Snapshot and clear pending maps before notifying
    // (notification callbacks may enqueue new notifications)
    const dataSnapshot = new Map(pendingData);
    const errorSnapshot = new Map(pendingErrors);
    const statusSnapshot = new Map(pendingFetchStatus);
    pendingData.clear();
    pendingErrors.clear();
    pendingFetchStatus.clear();

    // Deliver data notifications (isolated per observer to prevent cascade failure - SF-13)
    for (const [key, entry] of dataSnapshot) {
      const observers = getObservers(key);
      if (!observers) continue;
      for (const ob of observers) {
        try {
          ob.hasData = true;
          ob.onData(entry);
        } catch {
          /* swallow observer callback errors to protect other observers */
        }
      }
    }

    // Deliver error notifications
    for (const [key, error] of errorSnapshot) {
      const observers = getObservers(key);
      if (!observers) continue;
      for (const ob of observers) {
        try {
          ob.onError(error);
        } catch {
          /* swallow observer callback errors */
        }
      }
    }

    // Deliver fetchStatus notifications
    for (const [key, status] of statusSnapshot) {
      const observers = getObservers(key);
      if (!observers) continue;
      for (const ob of observers) {
        try {
          ob.onFetchStatusChange(status);
        } catch {
          /* swallow observer callback errors */
        }
      }
    }
  }

  function scheduleFlush(): void {
    if (scheduled) return;
    scheduled = true;

    if (interval === 0) {
      queueMicrotask(doFlush);
    } else {
      timerId = setTimeout(doFlush, interval);
    }
  }

  return {
    enqueueData(hashedKey: HashedKey, entry: CacheEntry): void {
      pendingData.set(hashedKey, entry);
      scheduleFlush();
    },

    enqueueError(hashedKey: HashedKey, error: SWRError): void {
      pendingErrors.set(hashedKey, error);
      scheduleFlush();
    },

    enqueueFetchStatus(hashedKey: HashedKey, status: "fetching" | "idle" | "paused"): void {
      pendingFetchStatus.set(hashedKey, status);
      scheduleFlush();
    },

    flush(): void {
      if (timerId !== null) {
        clearTimeout(timerId);
      }
      if (scheduled) {
        doFlush();
      }
    },

    _reset(): void {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      pendingData.clear();
      pendingErrors.clear();
      pendingFetchStatus.clear();
      scheduled = false;
    },
  };
}
