import { useStore, useVisibleTask$, useTask$, useContext, $ } from "@builder.io/qwik";
import type { QRL } from "@builder.io/qwik";
import type {
  ValidKey,
  HashedKey,
  Fetcher,
  SWRError,
  SWRInfiniteOptions,
  SWRInfiniteResponse,
  SWRInfiniteKeyLoader,
  SWRConfig,
} from "../types/index.ts";
import { SWRConfigContext } from "../provider/swr-provider.tsx";
import { resolveOptions } from "../utils/resolve-options.ts";
import { hashKey } from "../utils/hash.ts";
import { mapEagerness } from "./helpers.ts";
import { store } from "../cache/store.ts";
import { toSWRError } from "../utils/error.ts";
import { isContextNotFoundError } from "../utils/context-error.ts";
import { isDev, generateId } from "../utils/env.ts";
import { initEventManager } from "../cache/event-manager.ts";
import { timerCoordinator } from "../cache/timer-coordinator.ts";
import { fetchAllPages, checkIsReachingEnd } from "./infinite-helpers.ts";
import type { PageRetryConfig, FetchPagesResult } from "./infinite-helpers.ts";

// Re-export helpers for public API consumers
export { resolvePageKeys, checkIsReachingEnd, fetchAllPages, fetchPageWithRetry, calculateRetryDelay } from "./infinite-helpers.ts";
export type { FetchPagesContext, FetchPagesResult, PageRetryConfig } from "./infinite-helpers.ts";

// ═══════════════════════════════════════════════════════════════
// Callback helpers (shared between doFetch, setSize$, mutate$)
// ═══════════════════════════════════════════════════════════════

async function invokeOnSuccess<Data, K extends ValidKey>(
  options: SWRInfiniteOptions<Data> | undefined,
  getKeyFn: SWRInfiniteKeyLoader<Data, K>,
  pages: Data[],
): Promise<void> {
  if (!options?.onSuccess$) return;
  const onSuccess = await options.onSuccess$.resolve();
  const firstKey = getKeyFn(0, null);
  if (firstKey !== null) {
    onSuccess(pages, firstKey);
  }
}

async function invokeOnError<Data, K extends ValidKey>(
  options: SWRInfiniteOptions<Data> | undefined,
  providerConfig: SWRConfig | undefined,
  getKeyFn: SWRInfiniteKeyLoader<Data, K>,
  swrError: SWRError,
): Promise<void> {
  const firstKey = getKeyFn(0, null);
  if (firstKey === null) return;

  if (options?.onError$) {
    const onError = await options.onError$.resolve();
    onError(swrError, firstKey);
  }
  if (providerConfig?.onErrorGlobal$) {
    const onErrorGlobal = await providerConfig.onErrorGlobal$.resolve();
    onErrorGlobal(swrError, firstKey);
  }
}

// ═══════════════════════════════════════════════════════════════
// useSWRInfinite hook
// ═══════════════════════════════════════════════════════════════

/**
 * useSWRInfinite - Infinite loading hook for paginated data.
 *
 * Each page is cached individually using the key returned by getKey.
 * Pages are fetched sequentially (getKey receives previous page data).
 *
 * Features inherited from useSWR:
 * - retry with exponential backoff (per page)
 * - per-attempt timeout
 * - focus/reconnect revalidation
 * - refreshInterval via timerCoordinator
 * - onSuccess$/onError$/onErrorGlobal$ callbacks on all fetch paths
 * - cacheTime registered per page key for GC awareness
 * - dedupingInterval via store's shared cooldownMap (cross-instance)
 */
export function useSWRInfinite<Data, K extends ValidKey = ValidKey>(
  getKey: QRL<SWRInfiniteKeyLoader<Data, K>>,
  fetcher: QRL<Fetcher<Data, K>>,
  options?: SWRInfiniteOptions<Data>,
): SWRInfiniteResponse<Data> {
  // ─── Resolve config ───
  let providerConfig: SWRConfig | undefined;
  try {
    providerConfig = useContext(SWRConfigContext);
  } catch (e) {
    if (!isContextNotFoundError(e)) throw e;
    if (isDev()) {
      console.warn("[qwik-swr] No SWRProvider found in component tree. Using default config.");
    }
  }

  // Pass only CommonSWROptions fields to resolveOptions.
  // SWRInfiniteOptions.onSuccess$/onError$ have different signatures (Data[] vs Data)
  // and are handled separately in executeFetch.
  const resolved = resolveOptions(providerConfig, options ? {
    freshness: options.freshness,
    staleTime: options.staleTime,
    cacheTime: options.cacheTime,
    revalidateOn: options.revalidateOn,
    refreshInterval: options.refreshInterval,
    dedupingInterval: options.dedupingInterval,
    retry: options.retry,
    retryInterval: options.retryInterval,
    timeout: options.timeout,
    eagerness: options.eagerness,
  } : undefined);
  const infiniteOpts = {
    initialSize: options?.initialSize ?? 1,
    revalidateAll: options?.revalidateAll ?? false,
  };

  // Per-page retry config (same semantics as useSWR)
  const retryConfig: PageRetryConfig = {
    retry: resolved.retry,
    retryInterval: resolved.retryInterval,
    timeout: resolved.timeout,
  };

  // ─── State (useStore) ───
  const state = useStore<SWRInfiniteResponse<Data>>({
    data: undefined,
    error: undefined,
    size: infiniteOpts.initialSize,
    setSize$: undefined as unknown as SWRInfiniteResponse<Data>["setSize$"],
    mutate$: undefined as unknown as SWRInfiniteResponse<Data>["mutate$"],
    isLoading: false,
    isLoadingMore: false,
    isValidating: false,
    isReachingEnd: false,
    isRefreshing: false,
  });

  // Internal mutable ref for tracking state across QRL boundaries.
  const _internal = useStore<{
    currentSize: number;
    isFetching: boolean;
    tornDown: boolean;
    fetchGeneration: number;
    /** Stable page keys from the last successful fetch. Used by mutate$ to
     *  write cache entries without re-deriving keys from (possibly mutated) data. */
    pageKeyHashes: HashedKey[];
    /** Hashed first-page key, used as the cooldown identifier in store's shared cooldownMap. */
    cooldownKey: HashedKey;
  }>({
    currentSize: infiniteOpts.initialSize,
    isFetching: false,
    tornDown: false,
    fetchGeneration: 0,
    pageKeyHashes: [],
    cooldownKey: "" as HashedKey,
  });

  // ─── Shared fetch logic ───
  // Handles fetch, callbacks, generation guard, and cooldown.
  // Used by doFetch (lifecycle), setSize$, and mutate$ revalidation.

  async function executeFetch(
    getKeyFn: SWRInfiniteKeyLoader<Data, K>,
    fetcherFn: (ctx: import("../types/index.ts").FetcherCtx<K>) => Data | Promise<Data>,
    size: number,
    revalidateAll: boolean,
    signal: AbortSignal,
    generation: number,
  ): Promise<FetchPagesResult<Data, K> | null> {
    // Resolve cooldown key from first page (stable identifier for the list)
    const firstKey = getKeyFn(0, null);
    if (firstKey !== null) {
      _internal.cooldownKey = hashKey(firstKey);
    }

    try {
      const result = await fetchAllPages<Data, K>({
        getKeyFn,
        fetcherFn,
        size,
        revalidateAll,
        staleTime: resolved.staleTime,
        signal,
        retryConfig,
        resolvedConfig: resolved,
      });

      // Guard: only update state if this fetch is still the latest
      if (generation !== _internal.fetchGeneration) return null;

      state.data = result.pages;
      state.error = undefined;
      state.isReachingEnd = result.reachedEnd;
      _internal.pageKeyHashes = result.pageKeys.map(hashKey);

      // Start shared cooldown (success path)
      if (_internal.cooldownKey) {
        store.startCooldown(_internal.cooldownKey, resolved.dedupingInterval);
      }

      // onSuccess callback
      await invokeOnSuccess(options, getKeyFn, result.pages);

      return result;
    } catch (err) {
      if (generation !== _internal.fetchGeneration) return null;
      if (err instanceof DOMException && err.name === "AbortError") return null;

      const swrError = toSWRError(err);
      state.error = swrError;

      // Start shared cooldown (error path)
      if (_internal.cooldownKey) {
        store.startCooldown(_internal.cooldownKey, resolved.dedupingInterval);
      }

      // onError + onErrorGlobal$ callbacks
      await invokeOnError(options, providerConfig, getKeyFn, swrError);

      return null;
    } finally {
      if (generation === _internal.fetchGeneration) {
        state.isLoading = false;
        state.isLoadingMore = false;
        state.isValidating = false;
        state.isRefreshing = false;
        _internal.isFetching = false;
      }
    }
  }

  // Abort the current fetch across all paths (doFetch, setSize$, mutate$).
  // Incrementing fetchGeneration causes stale results to be discarded.
  function abortCurrentFetch(): { signal: AbortSignal; generation: number } {
    _internal.fetchGeneration++;
    const controller = new AbortController();
    return { signal: controller.signal, generation: _internal.fetchGeneration };
  }

  // ─── Main lifecycle ───
  useVisibleTask$(
    async ({ cleanup }) => {
      const getKeyFn = await getKey.resolve();
      const fetcherFn = await fetcher.resolve();

      const doFetch = async (size: number, revalidateAll: boolean) => {
        if (_internal.tornDown) return;

        // SF-3: Update size BEFORE executeFetch so it's correct even if fetch throws
        _internal.currentSize = size;
        state.size = size;

        const { signal, generation } = abortCurrentFetch();
        _internal.isFetching = true;

        const hasExistingData = state.data != null && state.data.length > 0;
        if (!hasExistingData) {
          state.isLoading = true;
        } else if (size > (state.data?.length ?? 0)) {
          state.isLoadingMore = true;
        } else {
          state.isRefreshing = true;
        }
        state.isValidating = true;

        await executeFetch(getKeyFn, fetcherFn, size, revalidateAll, signal, generation);
      };

      // Initial fetch
      await doFetch(infiniteOpts.initialSize, false);

      // dedupingInterval guard for event-triggered revalidation.
      // Uses store's shared cooldownMap keyed by first-page hash.
      const shouldSuppressRevalidation = (): boolean => {
        if (!_internal.cooldownKey) return false;
        return store.isCooldownActive(_internal.cooldownKey, resolved.dedupingInterval);
      };

      // Event-based revalidation (focus/reconnect) with dedup suppression
      const eventCleanup = initEventManager(resolved.revalidateOn, () => {
        if (!shouldSuppressRevalidation()) {
          doFetch(_internal.currentSize, infiniteOpts.revalidateAll);
        }
      });

      // Interval revalidation via TimerCoordinator with dedup suppression
      let unregisterTimer: (() => void) | null = null;
      if (resolved.refreshInterval > 0 && resolved.revalidateOn.includes("interval")) {
        const timerId = generateId("inf");
        unregisterTimer = timerCoordinator.register(resolved.refreshInterval, timerId, () => {
          if (!shouldSuppressRevalidation()) {
            doFetch(_internal.currentSize, infiniteOpts.revalidateAll);
          }
        });
      }

      cleanup(() => {
        _internal.tornDown = true;
        // Increment generation to discard any in-flight results
        _internal.fetchGeneration++;
        eventCleanup();
        unregisterTimer?.();
      });
    },
    { strategy: mapEagerness(resolved.eagerness) },
  );

  // ─── setSize$ ───
  const _setSize$ = $(async (sizeOrFn: number | ((current: number) => number)) => {
    const newSize = typeof sizeOrFn === "function" ? sizeOrFn(_internal.currentSize) : sizeOrFn;
    if (newSize < 0 || !Number.isFinite(newSize)) return;

    _internal.currentSize = newSize;
    state.size = newSize;

    // Must Fix: size decrease = trim existing data, no network request
    const currentPages = state.data;
    if (currentPages && newSize < currentPages.length) {
      state.data = currentPages.slice(0, newSize);
      _internal.pageKeyHashes = _internal.pageKeyHashes.slice(0, newSize);
      // Re-check isReachingEnd with trimmed data
      const getKeyFn = await getKey.resolve();
      state.isReachingEnd = checkIsReachingEnd(getKeyFn, state.data);
      return;
    }

    // Size same or increased: fetch needed
    const getKeyFn = await getKey.resolve();
    const fetcherFn = await fetcher.resolve();

    // SF-1: Use shared generation to abort any in-flight fetch (lifecycle or prior setSize$)
    const { signal, generation } = abortCurrentFetch();

    const hasExistingData = currentPages != null && currentPages.length > 0;
    if (!hasExistingData) {
      state.isLoading = true;
    } else if (newSize > (currentPages?.length ?? 0)) {
      state.isLoadingMore = true;
    } else {
      state.isRefreshing = true;
    }
    state.isValidating = true;

    await executeFetch(getKeyFn, fetcherFn, newSize, false, signal, generation);
  });

  // ─── mutate$ ───
  const _mutate$ = $(async (
    data?: Data[] | ((current: Data[] | undefined) => Data[]),
    mutateOptions?: { revalidate?: boolean },
  ) => {
    if (data !== undefined) {
      const resolvedData = typeof data === "function"
        ? (data as (current: Data[] | undefined) => Data[])(state.data)
        : data;

      state.data = resolvedData;

      // Write to cache using STABLE page keys from the last fetch.
      const stableHashes = _internal.pageKeyHashes;
      for (let i = 0; i < resolvedData.length; i++) {
        if (i < stableHashes.length) {
          store.setCache(stableHashes[i], {
            data: resolvedData[i],
            timestamp: Date.now(),
          });
        }
      }
    }

    const shouldRevalidate = mutateOptions?.revalidate ?? true;
    if (shouldRevalidate) {
      const getKeyFn = await getKey.resolve();
      const fetcherFn = await fetcher.resolve();

      // SF-1: Use shared generation to abort any in-flight fetch
      const { signal, generation } = abortCurrentFetch();

      state.isRefreshing = true;
      state.isValidating = true;

      // SF-2: Use infiniteOpts.revalidateAll instead of hardcoded true
      await executeFetch(getKeyFn, fetcherFn, _internal.currentSize, infiniteOpts.revalidateAll, signal, generation);
    }
  });

  // Assign QRLs to store outside render context
  useTask$(() => {
    state.setSize$ = _setSize$;
    state.mutate$ = _mutate$;
  });

  return state;
}
