import type {
  ValidKey,
  SWRInfiniteKeyLoader,
  FetcherCtx,
} from "../types/index.ts";
import { hashKey } from "../utils/hash.ts";
import { store } from "../cache/store.ts";

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
// Core fetch logic
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
