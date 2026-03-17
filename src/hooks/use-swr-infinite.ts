import { useStore, useVisibleTask$, useTask$, useContext, $ } from "@builder.io/qwik";
import type { QRL } from "@builder.io/qwik";
import type {
  ValidKey,
  Fetcher,
  SWRInfiniteOptions,
  SWRInfiniteResponse,
  SWRInfiniteKeyLoader,
  SWRError,
  FetcherCtx,
} from "../types/index.ts";
import { SWRConfigContext } from "../provider/swr-provider.tsx";
import { resolveOptions } from "../utils/resolve-options.ts";
import { hashKey } from "../utils/hash.ts";
import { mapEagerness } from "./helpers.ts";
import { store } from "../cache/store.ts";
import { toSWRError } from "../utils/error.ts";
import { isContextNotFoundError } from "../utils/context-error.ts";
import { isDev } from "../utils/env.ts";
import { initEventManager } from "../cache/event-manager.ts";

// ═══════════════════════════════════════════════════════════════
// Pure helpers (exported for unit testing)
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve sequential page keys by calling getKey for each page index.
 * Returns the list of resolved keys. Stops early when getKey returns null.
 */
export function resolvePageKeys<Data, K extends ValidKey>(
  getKey: SWRInfiniteKeyLoader<Data, K>,
  pageData: (Data | null)[],
  size: number,
): (K | null)[] {
  const keys: (K | null)[] = [];
  for (let i = 0; i < size; i++) {
    const previousData = i > 0 ? pageData[i - 1] : null;
    const key = getKey(i, previousData);
    keys.push(key);
    if (key === null) break;
  }
  return keys;
}

/**
 * Check if the next page key is null (i.e., we've reached the end).
 */
export function checkIsReachingEnd<Data, K extends ValidKey>(
  getKey: SWRInfiniteKeyLoader<Data, K>,
  pages: Data[],
): boolean {
  const nextKey = getKey(pages.length, pages.length > 0 ? pages[pages.length - 1] : null);
  return nextKey === null;
}

// ═══════════════════════════════════════════════════════════════
// Core fetch logic (exported for integration testing)
// ═══════════════════════════════════════════════════════════════

export interface FetchPagesContext<Data, K extends ValidKey> {
  getKeyFn: SWRInfiniteKeyLoader<Data, K>;
  fetcherFn: (ctx: FetcherCtx<K>) => Data | Promise<Data>;
  size: number;
  revalidateAll: boolean;
  staleTime: number;
  signal: AbortSignal;
}

/**
 * Fetch all pages sequentially. Each page's key depends on the previous page's data.
 * Returns the fetched pages and whether we've reached the end.
 */
export async function fetchAllPages<Data, K extends ValidKey>(
  ctx: FetchPagesContext<Data, K>,
): Promise<{ pages: Data[]; reachedEnd: boolean }> {
  const { getKeyFn, fetcherFn, size, revalidateAll, staleTime, signal } = ctx;
  const pages: Data[] = [];
  let reachedEnd = false;

  for (let i = 0; i < size; i++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const previousData = i > 0 ? pages[i - 1] : null;
    const key = getKeyFn(i, previousData);

    if (key === null) {
      reachedEnd = true;
      break;
    }

    const hashed = hashKey(key);

    // Check if we can use cached data (skip refetch for non-first pages when not revalidateAll)
    if (!revalidateAll && i > 0) {
      const cached = store.getCache<Data>(hashed);
      if (cached && cached.data !== undefined) {
        const age = Date.now() - cached.timestamp;
        if (age < staleTime) {
          pages.push(cached.data);
          continue;
        }
      }
    }

    // Fetch this page
    const fetchCtx: FetcherCtx<K> = {
      rawKey: key,
      hashedKey: hashed,
      signal,
    };

    const data = await fetcherFn(fetchCtx);

    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    // Cache the page individually
    store.setCache(hashed, {
      data,
      timestamp: Date.now(),
    });

    pages.push(data);
  }

  // Check if next page exists
  if (!reachedEnd) {
    reachedEnd = checkIsReachingEnd(getKeyFn, pages);
  }

  return { pages, reachedEnd };
}

// ═══════════════════════════════════════════════════════════════
// useSWRInfinite hook
// ═══════════════════════════════════════════════════════════════

/**
 * useSWRInfinite - Infinite loading hook for paginated data.
 *
 * Each page is cached individually using the key returned by getKey.
 * Pages are fetched sequentially by default (getKey receives previous page data).
 */
export function useSWRInfinite<Data, K extends ValidKey = ValidKey>(
  getKey: QRL<SWRInfiniteKeyLoader<Data, K>>,
  fetcher: QRL<Fetcher<Data, K>>,
  options?: SWRInfiniteOptions<Data>,
): SWRInfiniteResponse<Data> {
  // ─── Resolve config ───
  let providerConfig: import("../types/index.ts").SWRConfig | undefined;
  try {
    providerConfig = useContext(SWRConfigContext);
  } catch (e) {
    if (!isContextNotFoundError(e)) throw e;
    if (isDev()) {
      console.warn("[qwik-swr] No SWRProvider found in component tree. Using default config.");
    }
  }

  const resolved = resolveOptions(providerConfig, options);
  const infiniteOpts = {
    initialSize: options?.initialSize ?? 1,
    revalidateAll: options?.revalidateAll ?? false,
    revalidateFirstPage: options?.revalidateFirstPage ?? true,
    persistSize: options?.persistSize ?? false,
    parallel: options?.parallel ?? false,
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
  // Stored in useStore so it survives Qwik serialization.
  const _internal = useStore({
    currentSize: infiniteOpts.initialSize,
    isFetching: false,
    tornDown: false,
    // We track abort via a counter; each new fetch increments it.
    fetchGeneration: 0,
  });

  // ─── Main lifecycle ───
  useVisibleTask$(
    async ({ cleanup }) => {
      const getKeyFn = await getKey.resolve();
      const fetcherFn = await fetcher.resolve();

      // Shared abort controller for the current fetch
      let abortController = new AbortController();

      const doFetch = async (size: number, revalidateAll: boolean) => {
        if (_internal.tornDown) return;

        // Abort previous fetch
        abortController.abort();
        abortController = new AbortController();
        _internal.fetchGeneration++;
        const generation = _internal.fetchGeneration;
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

        try {
          const result = await fetchAllPages<Data, K>({
            getKeyFn,
            fetcherFn,
            size,
            revalidateAll,
            staleTime: resolved.staleTime,
            signal: abortController.signal,
          });

          // Guard: only update state if this fetch is still the latest
          if (generation !== _internal.fetchGeneration) return;

          state.data = result.pages;
          state.error = undefined;
          state.isReachingEnd = result.reachedEnd;
          _internal.currentSize = size;
          state.size = size;

          // onSuccess callback
          if (options?.onSuccess$) {
            const onSuccess = await options.onSuccess$.resolve();
            const firstKey = getKeyFn(0, null);
            if (firstKey !== null) {
              onSuccess(result.pages, firstKey);
            }
          }
        } catch (err) {
          if (generation !== _internal.fetchGeneration) return;
          if (err instanceof DOMException && err.name === "AbortError") return;

          const swrError = toSWRError(err);
          state.error = swrError;

          // onError callback
          if (options?.onError$) {
            const onError = await options.onError$.resolve();
            const firstKey = getKeyFn(0, null);
            if (firstKey !== null) {
              onError(swrError, firstKey);
            }
          }
        } finally {
          if (generation === _internal.fetchGeneration) {
            state.isLoading = false;
            state.isLoadingMore = false;
            state.isValidating = false;
            state.isRefreshing = false;
            _internal.isFetching = false;
          }
        }
      };

      // Initial fetch
      await doFetch(infiniteOpts.initialSize, false);

      // Event-based revalidation (focus/reconnect)
      const eventCleanup = initEventManager(resolved.revalidateOn, () => {
        doFetch(_internal.currentSize, infiniteOpts.revalidateAll);
      });

      cleanup(() => {
        _internal.tornDown = true;
        abortController.abort();
        eventCleanup();
      });
    },
    { strategy: mapEagerness(resolved.eagerness) },
  );

  // ─── setSize$ ───
  const _setSize$ = $(async (sizeOrFn: number | ((current: number) => number)) => {
    const newSize = typeof sizeOrFn === "function" ? sizeOrFn(_internal.currentSize) : sizeOrFn;
    if (newSize < 0) return;

    _internal.currentSize = newSize;
    state.size = newSize;

    const getKeyFn = await getKey.resolve();
    const fetcherFn = await fetcher.resolve();

    // Create a new abort controller for this fetch
    const controller = new AbortController();
    _internal.fetchGeneration++;
    const generation = _internal.fetchGeneration;

    const hasExistingData = state.data != null && state.data.length > 0;
    if (!hasExistingData) {
      state.isLoading = true;
    } else if (newSize > (state.data?.length ?? 0)) {
      state.isLoadingMore = true;
    } else {
      state.isRefreshing = true;
    }
    state.isValidating = true;

    try {
      const result = await fetchAllPages<Data, K>({
        getKeyFn,
        fetcherFn,
        size: newSize,
        revalidateAll: false,
        staleTime: resolved.staleTime,
        signal: controller.signal,
      });

      if (generation !== _internal.fetchGeneration) return;

      state.data = result.pages;
      state.error = undefined;
      state.isReachingEnd = result.reachedEnd;
    } catch (err) {
      if (generation !== _internal.fetchGeneration) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      state.error = toSWRError(err);
    } finally {
      if (generation === _internal.fetchGeneration) {
        state.isLoading = false;
        state.isLoadingMore = false;
        state.isValidating = false;
        state.isRefreshing = false;
      }
    }
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

      // Update individual page caches
      const getKeyFn = await getKey.resolve();
      for (let i = 0; i < resolvedData.length; i++) {
        const prevData = i > 0 ? resolvedData[i - 1] : null;
        const pageKey = getKeyFn(i, prevData);
        if (pageKey !== null) {
          store.setCache(hashKey(pageKey), {
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

      const controller = new AbortController();
      _internal.fetchGeneration++;
      const generation = _internal.fetchGeneration;

      state.isRefreshing = true;
      state.isValidating = true;

      try {
        const result = await fetchAllPages<Data, K>({
          getKeyFn,
          fetcherFn,
          size: _internal.currentSize,
          revalidateAll: true,
          staleTime: resolved.staleTime,
          signal: controller.signal,
        });

        if (generation !== _internal.fetchGeneration) return;

        state.data = result.pages;
        state.error = undefined;
        state.isReachingEnd = result.reachedEnd;
      } catch (err) {
        if (generation !== _internal.fetchGeneration) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        state.error = toSWRError(err);
      } finally {
        if (generation === _internal.fetchGeneration) {
          state.isRefreshing = false;
          state.isValidating = false;
        }
      }
    }
  });

  // Assign QRLs to store outside render context
  useTask$(() => {
    state.setSize$ = _setSize$;
    state.mutate$ = _mutate$;
  });

  return state;
}
