import type { ValidKey, HashedKey, ResolvedQueryConfig, FetcherCtx } from "../types/index.ts";
import type { Observer } from "../cache/types.ts";
import { startFetchLifecycle } from "./lifecycle-state.ts";

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
 *
 * Delegates to startFetchLifecycle and wires teardown to cleanup callback.
 */
export function setupFetchLifecycle<Data>(
  params: FetchLifecycleParams<Data>,
  cleanup: (fn: () => void) => void,
): void {
  const lifecycle = startFetchLifecycle(params);
  cleanup(() => lifecycle.teardown());
}
