import type { ValidKey, ResolvedSWROptions, SWRError, Fetcher } from "../types/index.ts";
import type { QRL } from "@builder.io/qwik";
import { store } from "../cache/store.ts";
import { hashKey } from "../utils/hash.ts";
import { isDisabledKey } from "../utils/resolve-key.ts";

/** Parameters for mutation operations. Uses keyRef for reactive key support. */
export interface MutationContext<Data, K extends ValidKey> {
  /** Mutable reference to the current key. Read at call time for latest value. */
  keyRef: { current: K | null | undefined | false };
  state: {
    data: Data | undefined;
    error: SWRError | undefined;
    status: import("../types/index.ts").Status;
    isSuccess: boolean;
    isError: boolean;
  };
  resolved: ResolvedSWROptions<Data>;
  fetcher: QRL<Fetcher<Data, K>>;
}

/**
 * Perform an optimistic mutation: update local state, write to cache,
 * and optionally trigger revalidation.
 */
export async function performMutate<Data, K extends ValidKey>(
  ctx: MutationContext<Data, K>,
  newData: Data | ((current: Data | undefined) => Data),
  mutateOptions?: { revalidate?: boolean },
): Promise<void> {
  const key = ctx.keyRef.current;
  if (isDisabledKey(key)) return;

  const hashed = hashKey(key);

  // Resolve new data
  const resolvedData =
    typeof newData === "function"
      ? (newData as (current: Data | undefined) => Data)(ctx.state.data)
      : newData;

  // Update local state
  ctx.state.data = resolvedData;
  ctx.state.error = undefined;
  ctx.state.status = "success";
  ctx.state.isSuccess = true;
  ctx.state.isError = false;

  // Update cache store
  store.setCache(hashed, {
    data: resolvedData,
    timestamp: Date.now(),
  });

  // Conditional revalidation (catch revalidation errors to prevent mutation failure - SF-10)
  const shouldRevalidate = mutateOptions?.revalidate ?? true;
  if (shouldRevalidate && ctx.resolved.enabled) {
    try {
      const fetcherFn = await ctx.fetcher.resolve();
      await store.forceRevalidate(hashed, key, fetcherFn);
    } catch {
      // Revalidation failure should not fail the mutation itself.
      // The fetch error will be handled by observer error callbacks.
    }
  }
}

/**
 * Force revalidation: re-fetch data from the server for the given key.
 * Returns the current data value (may not reflect the new fetch yet).
 */
export async function performRevalidate<Data, K extends ValidKey>(
  ctx: MutationContext<Data, K>,
): Promise<Data | undefined> {
  const key = ctx.keyRef.current;
  if (isDisabledKey(key)) return ctx.state.data;
  if (!ctx.resolved.enabled) return ctx.state.data;

  const hashed = hashKey(key);
  const fetcherFn = await ctx.fetcher.resolve();

  const freshData = await store.forceRevalidate<K, Data>(hashed, key, fetcherFn);
  if (freshData !== undefined) {
    ctx.state.data = freshData;
  }
  return ctx.state.data;
}
