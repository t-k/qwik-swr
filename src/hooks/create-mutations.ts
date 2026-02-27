import type { ValidKey, ResolvedSWROptions, SWRError, Fetcher } from "../types/index.ts";
import type { QRL } from "@builder.io/qwik";
import { store } from "../cache/store.ts";
import { hashKey } from "../utils/hash.ts";

/** Parameters for mutation operations. Uses useStore state object instead of Signal. */
export interface MutationContext<Data, K extends ValidKey> {
  key: K | null | undefined | false;
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
  if (ctx.key === null || ctx.key === undefined || ctx.key === false) return;

  const hashed = hashKey(ctx.key);

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
      await store.forceRevalidate(hashed, ctx.key, fetcherFn);
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
  if (ctx.key === null || ctx.key === undefined || ctx.key === false) return ctx.state.data;
  if (!ctx.resolved.enabled) return ctx.state.data;

  const hashed = hashKey(ctx.key);
  const fetcherFn = await ctx.fetcher.resolve();

  const freshData = await store.forceRevalidate<K, Data>(hashed, ctx.key, fetcherFn);
  if (freshData !== undefined) {
    ctx.state.data = freshData;
  }
  return ctx.state.data;
}
