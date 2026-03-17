import type {
  ValidKey,
  HashedKey,
  SWRInfiniteKeyLoader,
  FetcherCtx,
  SWRError,
} from "../types/index.ts";
import { hashKey } from "../utils/hash.ts";
import { store } from "../cache/store.ts";
import { toSWRError } from "../utils/error.ts";

// ═══════════════════════════════════════════════════════════════
// Pure helpers for useSWRInfinite (testable without Qwik runtime)
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
// Retry helpers
// ═══════════════════════════════════════════════════════════════

/** Calculate exponential backoff delay for retry. */
export function calculateRetryDelay(
  retryCount: number,
  error: SWRError,
  retryInterval: number | ((retryCount: number, error: SWRError) => number),
): number {
  if (typeof retryInterval === "function") {
    return retryInterval(retryCount, error);
  }
  return retryInterval * 2 ** retryCount;
}

/** Per-page retry configuration. */
export interface PageRetryConfig {
  retry: number;
  retryInterval: number | ((retryCount: number, error: SWRError) => number);
  timeout: number;
}

/**
 * Fetch a single page with retry and timeout.
 * Implements the same retry semantics as store-fetch.ts startFetch.
 */
export async function fetchPageWithRetry<Data, K extends ValidKey>(
  fetcherFn: (ctx: FetcherCtx<K>) => Data | Promise<Data>,
  key: K,
  hashed: HashedKey,
  signal: AbortSignal,
  config: PageRetryConfig,
  retryCount = 0,
): Promise<Data> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  // Per-attempt timeout via AbortController chaining
  const timeoutController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  if (config.timeout > 0) {
    timeoutId = setTimeout(() => timeoutController.abort(), config.timeout);
  }
  // Propagate parent signal abort to timeout controller
  const onParentAbort = () => timeoutController.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });

  const ctx: FetcherCtx<K> = {
    rawKey: key,
    hashedKey: hashed,
    signal: timeoutController.signal,
  };

  try {
    const result = fetcherFn(ctx);
    const data = await Promise.resolve(result);

    if (timeoutId !== null) clearTimeout(timeoutId);
    signal.removeEventListener("abort", onParentAbort);

    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    return data;
  } catch (err) {
    if (timeoutId !== null) clearTimeout(timeoutId);
    signal.removeEventListener("abort", onParentAbort);

    // Don't retry abort (parent signal)
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    // Timeout from our own controller = classify as timeout, but still retryable
    if (timeoutController.signal.aborted && !signal.aborted) {
      const timeoutErr = toSWRError(new DOMException("Timeout", "TimeoutError"), retryCount);
      if (retryCount < config.retry) {
        const delay = calculateRetryDelay(retryCount, timeoutErr, config.retryInterval);
        await new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
            resolve();
          }, delay);
        });
        return fetchPageWithRetry(fetcherFn, key, hashed, signal, config, retryCount + 1);
      }
      throw timeoutErr;
    }

    // Retry on other errors
    if (retryCount < config.retry) {
      const swrErr = toSWRError(err, retryCount);
      const delay = calculateRetryDelay(retryCount, swrErr, config.retryInterval);
      await new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
          resolve();
        }, delay);
      });
      return fetchPageWithRetry(fetcherFn, key, hashed, signal, config, retryCount + 1);
    }

    throw toSWRError(err, retryCount);
  }
}

// ═══════════════════════════════════════════════════════════════
// Core fetch logic
// ═══════════════════════════════════════════════════════════════

export interface FetchPagesContext<Data, K extends ValidKey> {
  getKeyFn: SWRInfiniteKeyLoader<Data, K>;
  fetcherFn: (ctx: FetcherCtx<K>) => Data | Promise<Data>;
  size: number;
  revalidateAll: boolean;
  staleTime: number;
  signal: AbortSignal;
  /** Per-page retry config. When omitted, no retry is performed. */
  retryConfig?: PageRetryConfig;
}

export interface FetchPagesResult<Data, K extends ValidKey> {
  pages: Data[];
  reachedEnd: boolean;
  /** Keys used for each page (stable reference for cache writes). */
  pageKeys: K[];
}

/**
 * Fetch all pages sequentially. Each page's key depends on the previous page's data.
 * Returns the fetched pages, their keys, and whether we've reached the end.
 */
export async function fetchAllPages<Data, K extends ValidKey>(
  ctx: FetchPagesContext<Data, K>,
): Promise<FetchPagesResult<Data, K>> {
  const { getKeyFn, fetcherFn, size, revalidateAll, staleTime, signal, retryConfig } = ctx;
  const pages: Data[] = [];
  const pageKeys: K[] = [];
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
          pageKeys.push(key);
          continue;
        }
      }
    }

    // Fetch this page (with or without retry)
    let data: Data;
    if (retryConfig) {
      data = await fetchPageWithRetry(fetcherFn, key, hashed, signal, retryConfig);
    } else {
      const fetchCtx: FetcherCtx<K> = { rawKey: key, hashedKey: hashed, signal };
      data = await Promise.resolve(fetcherFn(fetchCtx));
    }

    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    // Cache the page individually
    store.setCache(hashed, {
      data,
      timestamp: Date.now(),
    });

    pages.push(data);
    pageKeys.push(key);
  }

  // Check if next page exists
  if (!reachedEnd) {
    reachedEnd = checkIsReachingEnd(getKeyFn, pages);
  }

  return { pages, reachedEnd, pageKeys };
}
