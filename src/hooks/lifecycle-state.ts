import type { ValidKey, HashedKey, ResolvedQueryConfig, FetcherCtx } from "../types/index.ts";
import type { Observer } from "../cache/types.ts";
import { store } from "../cache/store.ts";
import { initEventManager } from "../cache/event-manager.ts";
import { timerCoordinator } from "../cache/timer-coordinator.ts";

/** A running fetch lifecycle that can be torn down imperatively. */
export interface ActiveLifecycle<Data> {
  hashedKey: HashedKey;
  rawKey: ValidKey;
  observer: Observer<Data>;
  /** Tear down all resources (observer, event handlers, timers). */
  teardown(): void;
}

/** Parameters for starting a fetch lifecycle. */
export interface StartFetchLifecycleParams<Data> {
  hashedKey: HashedKey;
  rawKey: ValidKey;
  fetcherFn: (ctx: FetcherCtx<any>) => Data | Promise<Data>;
  observer: Observer<Data>;
  resolved: ResolvedQueryConfig<Data>;
}

/**
 * Start a fetch lifecycle: attach observer, trigger initial fetch,
 * register event-based revalidation, and schedule interval polling.
 *
 * Returns an ActiveLifecycle with an imperative teardown() method,
 * suitable for use with Signal key changes where cleanup needs to
 * happen before the next key's lifecycle starts.
 */
export function startFetchLifecycle<Data>(
  params: StartFetchLifecycleParams<Data>,
): ActiveLifecycle<Data> {
  const { hashedKey, rawKey, fetcherFn, observer, resolved } = params;

  // Attach observer to CacheStore
  store.attachObserver(hashedKey, observer as Observer<unknown>, resolved as ResolvedQueryConfig);

  // Trigger initial fetch
  store.ensureFetch(hashedKey, rawKey, fetcherFn);

  // Event Manager: register focus/reconnect handlers
  const eventCleanup = initEventManager(resolved.revalidateOn, () => {
    store.ensureFetch(hashedKey, rawKey, fetcherFn);
  });

  // Interval revalidation via TimerCoordinator
  let unregisterTimer: (() => void) | null = null;
  if (resolved.refreshInterval > 0 && resolved.revalidateOn.includes("interval")) {
    unregisterTimer = timerCoordinator.register(resolved.refreshInterval, observer.id, () => {
      store.ensureFetch(hashedKey, rawKey, fetcherFn);
    });
  }

  let tornDown = false;

  return {
    hashedKey,
    rawKey,
    observer,
    teardown() {
      if (tornDown) return;
      tornDown = true;
      store.detachObserver(hashedKey, observer as Observer<unknown>);
      eventCleanup();
      unregisterTimer?.();
    },
  };
}
