import type { ValidKey, HashedKey, ResolvedQueryConfig, FetcherCtx } from "../types/index.ts";
import type { Observer } from "../cache/types.ts";
import { store } from "../cache/store.ts";
import { initEventManager } from "../cache/event-manager.ts";
import { timerCoordinator } from "../cache/timer-coordinator.ts";

/** Parameters for setting up the fetch lifecycle inside useVisibleTask$. */
export interface FetchLifecycleParams<Data> {
  hashedKey: HashedKey;
  rawKey: ValidKey;
  fetcherFn: (ctx: FetcherCtx<any>) => Data | Promise<Data>;
  observer: Observer<Data>;
  resolved: ResolvedQueryConfig<Data>;
}

/**
 * Set up the fetch lifecycle: attach observer, trigger initial fetch,
 * register event-based revalidation, and schedule interval polling.
 *
 * Must be called inside a useVisibleTask$ callback.
 * Registers all cleanup handlers via the provided `cleanup` function.
 */
export function setupFetchLifecycle<Data>(
  params: FetchLifecycleParams<Data>,
  cleanup: (fn: () => void) => void,
): void {
  const { hashedKey, rawKey, fetcherFn, observer, resolved } = params;

  // Attach observer to CacheStore
  store.attachObserver(hashedKey, observer as Observer<unknown>, resolved as ResolvedQueryConfig);

  // Trigger initial fetch
  store.ensureFetch(hashedKey, rawKey, fetcherFn);

  // Event Manager: register focus/reconnect handlers
  const eventCleanup = initEventManager(resolved.revalidateOn, () => {
    store.ensureFetch(hashedKey, rawKey, fetcherFn);
  });

  // Interval revalidation via TimerCoordinator (shared timers for same interval)
  let unregisterTimer: (() => void) | null = null;
  if (resolved.refreshInterval > 0 && resolved.revalidateOn.includes("interval")) {
    unregisterTimer = timerCoordinator.register(resolved.refreshInterval, observer.id, () => {
      store.ensureFetch(hashedKey, rawKey, fetcherFn);
    });
  }

  // Cleanup on unmount
  cleanup(() => {
    store.detachObserver(hashedKey, observer as Observer<unknown>);
    eventCleanup();
    unregisterTimer?.();
  });
}
