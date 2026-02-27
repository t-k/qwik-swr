import type {
  HashedKey,
  ValidKey,
  CacheEntry,
  SWRError,
  FetchStatus,
  ResolvedQueryConfig,
  FetcherCtx,
} from "../types/index.ts";
import type { StoreState } from "./store-context.ts";
import type { InFlightEntry } from "./types.ts";
import { toSWRError, serializeSWRError } from "../utils/error.ts";

// ═══════════════════════════════════════════════════════════════
// Fetch Engine — fetch execution, retry, cooldown, ensureFetch,
//                forceRevalidate, setOnline
// ═══════════════════════════════════════════════════════════════

export interface FetchEngineDeps {
  notifyObservers: (key: HashedKey, entry: CacheEntry) => void;
  notifyError: (key: HashedKey, error: SWRError) => void;
  broadcastFetchStatus: (key: HashedKey, status: FetchStatus) => void;
  safeStorageOp: (op: Promise<void> | void, operation: string, key?: HashedKey) => void;
}

export interface FetchEngineApi {
  startFetch<K extends ValidKey, Data>(
    hashedKey: HashedKey,
    rawKey: K,
    fetcher: (ctx: FetcherCtx<K>) => Data | Promise<Data>,
    cfg: ResolvedQueryConfig,
    retryCount?: number,
  ): Promise<Data>;
  startCooldown(hashedKey: HashedKey, dedupingInterval: number): void;
  ensureFetch<K extends ValidKey, Data>(
    hashedKey: HashedKey,
    rawKey: K,
    fetcher: (ctx: FetcherCtx<K>) => Data | Promise<Data>,
  ): void;
  forceRevalidate<K extends ValidKey, Data>(
    hashedKey: HashedKey,
    rawKey: K,
    fetcher: (ctx: FetcherCtx<K>) => Data | Promise<Data>,
    defaultConfig: ResolvedQueryConfig,
  ): Promise<Data | undefined>;
  setOnline(
    online: boolean,
    ensureFetchFn: <K extends ValidKey, Data>(
      hashedKey: HashedKey,
      rawKey: K,
      fetcher: (ctx: FetcherCtx<K>) => Data | Promise<Data>,
    ) => void,
  ): void;
}

export function createFetchEngine(state: StoreState, deps: FetchEngineDeps): FetchEngineApi {
  // ─── Cooldown ───

  function startCooldown(hashedKey: HashedKey, dedupingInterval: number): void {
    if (dedupingInterval <= 0) return;
    const timerId = setTimeout(() => state.cooldownMap.delete(hashedKey), dedupingInterval);
    state.cooldownMap.set(hashedKey, { hashedKey, completedAt: Date.now(), timerId });
  }

  // ─── Retry delay ───

  function calculateRetryDelay(
    retryCount: number,
    error: SWRError,
    retryInterval: number | ((retryCount: number, error: SWRError) => number),
  ): number {
    if (typeof retryInterval === "function") {
      return retryInterval(retryCount, error);
    }
    // Exponential backoff: retryInterval * 2^retryCount
    return retryInterval * 2 ** retryCount;
  }

  // ─── Internal: execute fetch ───

  function startFetch<K extends ValidKey, Data>(
    hashedKey: HashedKey,
    rawKey: K,
    fetcher: (ctx: FetcherCtx<K>) => Data | Promise<Data>,
    cfg: ResolvedQueryConfig,
    retryCount = 0,
  ): Promise<Data> {
    // Store fetcher for later use by cache.mutate revalidation
    state.fetcherMap.set(
      hashedKey,
      fetcher as (ctx: FetcherCtx<any>) => unknown | Promise<unknown>,
    );

    // Only set up requestId, abortController, and inflight on initial call (not retries)
    const isRetry = retryCount > 0;

    let requestId: number;
    let abortController: AbortController;
    let inflightEntry: InFlightEntry;
    // Timeout timer (cleared on completion to avoid leaking timers - SF-1)
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    if (!isRetry) {
      requestId = state.nextRequestId++;
      state.latestRequestId.set(hashedKey, requestId);
      abortController = new AbortController();

      if (cfg.timeout > 0) {
        timeoutId = setTimeout(() => abortController.abort(), cfg.timeout);
      }

      // fetchStatus -> fetching
      deps.broadcastFetchStatus(hashedKey, "fetching");

      // Register in inflightMap BEFORE calling fetcher
      const observerCount = state.observerRegistry.get(hashedKey)?.size ?? 0;
      inflightEntry = {
        hashedKey,
        promise: null as unknown as Promise<unknown>,
        abortController,
        requestId,
        observerCount,
      };
      state.inflightMap.set(hashedKey, inflightEntry);
    } else {
      // Retry: reuse existing inflight entry
      inflightEntry = state.inflightMap.get(hashedKey)!;
      if (!inflightEntry)
        return Promise.reject(new Error("Aborted between retries")) as Promise<Data>;
      requestId = inflightEntry.requestId;
      abortController = inflightEntry.abortController;
      // Set up timeout for retry fetch (same as initial - SF-1 retry)
      if (cfg.timeout > 0) {
        timeoutId = setTimeout(() => abortController.abort(), cfg.timeout);
      }
    }

    // FetcherCtx
    const ctx: FetcherCtx<K> = {
      rawKey,
      hashedKey,
      signal: abortController.signal,
    };

    // Call fetcher synchronously, then chain on result
    let resultPromise: Promise<Data>;
    try {
      const result = fetcher(ctx);
      resultPromise = Promise.resolve(result);
    } catch (e) {
      resultPromise = Promise.reject(e);
    }

    const promise = resultPromise
      .then((data) => {
        // Clear timeout timer on successful completion (SF-1)
        if (timeoutId !== null) clearTimeout(timeoutId);

        // Don't commit on abort (e.g. all observers detached)
        if (abortController.signal.aborted) return data;

        // Remove from inflight first
        state.inflightMap.delete(hashedKey);

        // Race control: only latest requestId commits
        if (state.latestRequestId.get(hashedKey) !== requestId) {
          startCooldown(hashedKey, cfg.dedupingInterval);
          deps.broadcastFetchStatus(hashedKey, "idle");
          return data;
        }

        const now = Date.now();

        // volatile (cacheTime=0): don't store in cacheMap
        if (cfg.cacheTime > 0) {
          const entry: CacheEntry = { data, timestamp: now };
          state.cacheMap.set(hashedKey, entry);
          deps.safeStorageOp(state.storage?.set(hashedKey, entry), "set", hashedKey);
        }

        // Notify observers
        deps.notifyObservers(hashedKey, { data, timestamp: now });

        // Start cooldown
        startCooldown(hashedKey, cfg.dedupingInterval);
        deps.broadcastFetchStatus(hashedKey, "idle");

        // Call onSuccess$ if configured
        void cfg.onSuccess$?.resolve().then((fn) => fn(data, rawKey));

        return data;
      })
      .catch((e) => {
        // Clear timeout timer on error (SF-1)
        if (timeoutId !== null) clearTimeout(timeoutId);

        // Don't retry on abort
        if (abortController.signal.aborted) {
          state.inflightMap.delete(hashedKey);
          throw e;
        }

        if (state.latestRequestId.get(hashedKey) !== requestId) {
          state.inflightMap.delete(hashedKey);
          startCooldown(hashedKey, cfg.dedupingInterval);
          deps.broadcastFetchStatus(hashedKey, "idle");
          throw e;
        }

        // Retry logic
        if (retryCount < cfg.retry) {
          const swrErr = toSWRError(e, retryCount);
          const delay = calculateRetryDelay(retryCount, swrErr, cfg.retryInterval);
          return new Promise<Data>((resolve, reject) => {
            setTimeout(() => {
              // Guard: check abort again after delay
              if (abortController.signal.aborted) {
                reject(e);
                return;
              }
              if (!state.inflightMap.has(hashedKey)) {
                reject(e);
                return;
              }
              startFetch<K, Data>(hashedKey, rawKey, fetcher, cfg, retryCount + 1).then(
                resolve,
                reject,
              );
            }, delay);
          });
        }

        // All retries exhausted
        state.inflightMap.delete(hashedKey);

        const swrError = toSWRError(e, retryCount);

        // Persist error in cache entry (stale-while-error: preserve existing data)
        const existing = state.cacheMap.get(hashedKey);
        const errorEntry: CacheEntry = {
          data: existing?.data,
          timestamp: Date.now(),
          error: serializeSWRError(swrError),
        };
        state.cacheMap.set(hashedKey, errorEntry);
        deps.safeStorageOp(state.storage?.set(hashedKey, errorEntry), "set", hashedKey);

        // Notify error
        deps.notifyError(hashedKey, swrError);

        // Start cooldown
        startCooldown(hashedKey, cfg.dedupingInterval);
        deps.broadcastFetchStatus(hashedKey, "idle");

        // Call onError$ and onErrorGlobal$ if configured
        void cfg.onError$?.resolve().then((fn) => fn(swrError, rawKey));
        void cfg.onErrorGlobal$?.resolve().then((fn) => fn(swrError, rawKey));

        throw swrError;
      });

    inflightEntry.promise = promise as Promise<unknown>;

    return promise;
  }

  // ─── ensureFetch ───

  function ensureFetch<K extends ValidKey, Data>(
    hashedKey: HashedKey,
    rawKey: K,
    fetcher: (ctx: FetcherCtx<K>) => Data | Promise<Data>,
  ): void {
    const cfg = state.queryConfigMap.get(hashedKey);
    if (!cfg) return;

    // Stage 0: offline -> defer fetch (save fetcher so setOnline can resume)
    if (!state.isOnline) {
      state.pendingKeys.add(hashedKey);
      state.fetcherMap.set(
        hashedKey,
        fetcher as (ctx: FetcherCtx<any>) => unknown | Promise<unknown>,
      );
      deps.broadcastFetchStatus(hashedKey, "paused");
      return;
    }

    // Stage 1: in-flight join
    const inflight = state.inflightMap.get(hashedKey);
    if (inflight) {
      inflight.observerCount =
        state.observerRegistry.get(hashedKey)?.size ?? inflight.observerCount;
      deps.broadcastFetchStatus(hashedKey, "fetching");
      return;
    }

    // Stage 1.5: cross-tab dedup — another tab is fetching this key
    if (state.dedupEnabled && state.remoteInflight.has(hashedKey)) {
      return;
    }

    // Check if displayable data exists
    const hasCacheData = state.cacheMap.has(hashedKey);
    let anyObserverHasData = false;
    const observers = state.observerRegistry.get(hashedKey);
    if (observers) {
      for (const o of observers) {
        if (o.hasData) {
          anyObserverHasData = true;
          break;
        }
      }
    }
    const canCooldownSuppress = hasCacheData || anyObserverHasData;

    // Stage 2: cooldown + displayable data -> suppress
    const cooldown = state.cooldownMap.get(hashedKey);
    if (cooldown && canCooldownSuppress) {
      const elapsed = Date.now() - cooldown.completedAt;
      if (elapsed < cfg.dedupingInterval) {
        return; // suppress
      }
      clearTimeout(cooldown.timerId);
      state.cooldownMap.delete(hashedKey);
    }

    // Fresh check
    const cached = state.cacheMap.get(hashedKey);
    if (cached) {
      const age = Date.now() - cached.timestamp;
      if (age < cfg.staleTime) {
        return; // fresh -> skip
      }
    }

    // Dispatch new fetch (fire-and-forget: rejection handled by observers)
    void startFetch(hashedKey, rawKey, fetcher, cfg).catch(() => {});
  }

  // ─── forceRevalidate ───

  function forceRevalidate<K extends ValidKey, Data>(
    hashedKey: HashedKey,
    rawKey: K,
    fetcher: (ctx: FetcherCtx<K>) => Data | Promise<Data>,
    defaultConfig: ResolvedQueryConfig,
  ): Promise<Data | undefined> {
    // Use stored config or default for prefetched keys without observers
    const cfg = state.queryConfigMap.get(hashedKey) ?? defaultConfig;

    // Offline guard: defer fetch (same pattern as ensureFetch Stage 0)
    if (!state.isOnline) {
      state.pendingKeys.add(hashedKey);
      state.fetcherMap.set(
        hashedKey,
        fetcher as (ctx: FetcherCtx<any>) => unknown | Promise<unknown>,
      );
      deps.broadcastFetchStatus(hashedKey, "paused");
      return Promise.resolve(undefined);
    }

    // Abort existing inflight
    const inflight = state.inflightMap.get(hashedKey);
    if (inflight) {
      inflight.abortController.abort();
      state.inflightMap.delete(hashedKey);
    }

    // Clear cooldown (including its timer - SF-4)
    const existingCooldown = state.cooldownMap.get(hashedKey);
    if (existingCooldown) {
      clearTimeout(existingCooldown.timerId);
      state.cooldownMap.delete(hashedKey);
    }

    // New fetch
    return startFetch(hashedKey, rawKey, fetcher, cfg);
  }

  // ─── setOnline ───

  function setOnline(
    online: boolean,
    ensureFetchFn: <K extends ValidKey, Data>(
      hashedKey: HashedKey,
      rawKey: K,
      fetcher: (ctx: FetcherCtx<K>) => Data | Promise<Data>,
    ) => void,
  ): void {
    const wasOffline = !state.isOnline;
    state.isOnline = online;

    if (!online) {
      // Going offline: broadcast "paused" for all inflight keys
      for (const [hashedKey] of state.inflightMap) {
        deps.broadcastFetchStatus(hashedKey, "paused");
      }
    } else if (wasOffline) {
      // Coming back online: resume pending fetches
      for (const hashedKey of state.pendingKeys) {
        const fetcher = state.fetcherMap.get(hashedKey);
        const observers = state.observerRegistry.get(hashedKey);
        if (fetcher && observers && observers.size > 0) {
          const firstObserver = observers.values().next().value;
          if (firstObserver) {
            ensureFetchFn(hashedKey, firstObserver.lastRawKey, fetcher);
          }
        }
      }
      state.pendingKeys.clear();

      // Resume inflight status
      for (const [hashedKey] of state.inflightMap) {
        deps.broadcastFetchStatus(hashedKey, "fetching");
      }
    }
  }

  return { startFetch, startCooldown, ensureFetch, forceRevalidate, setOnline };
}
