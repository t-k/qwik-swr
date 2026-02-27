import { useStore, useVisibleTask$, useTask$, useContext, $ } from "@builder.io/qwik";
import type { QRL } from "@builder.io/qwik";
import type { SWRKey, ValidKey, Fetcher, SWROptions, SWRResponse } from "../types/index.ts";
import { SWRConfigContext } from "../provider/swr-provider.tsx";
import { resolveOptions } from "../utils/resolve-options.ts";
import { hashKey } from "../utils/hash.ts";
import { mapEagerness } from "./helpers.ts";
import { createObserver } from "./create-observer.ts";
import { setupFetchLifecycle } from "./use-fetch-lifecycle.ts";
import { performMutate, performRevalidate, type MutationContext } from "./create-mutations.ts";
import { isContextNotFoundError } from "../utils/context-error.ts";
import { isDev } from "../utils/env.ts";

// ═══════════════════════════════════════════════════════════════
// useSWR hook
// ═══════════════════════════════════════════════════════════════

/**
 * Overload 1: Valid key with type inference
 *
 * @remarks
 * The `key` parameter is captured by value at hook creation time and is
 * **not reactive**. Changing the key after mount will not trigger a re-fetch.
 * To fetch different keys conditionally, use separate `useSWR` calls or
 * pass `null`/`false` to disable.
 */
export function useSWR<Data, K extends ValidKey>(
  key: K,
  fetcher: QRL<Fetcher<Data, K>>,
  options?: SWROptions<Data>,
): SWRResponse<Data>;

/** Overload 2: Disabled key */
export function useSWR<Data>(
  key: null | undefined | false,
  fetcher: QRL<Fetcher<Data, any>>,
  options?: SWROptions<Data>,
): SWRResponse<Data>;

/** Overload 3: Runtime key (conditional fetch) */
export function useSWR<Data, K extends ValidKey = ValidKey>(
  key: SWRKey,
  fetcher: QRL<Fetcher<Data, K>>,
  options?: SWROptions<Data>,
): SWRResponse<Data>;

/** Implementation */
export function useSWR<Data, K extends ValidKey = ValidKey>(
  key: SWRKey,
  fetcher: QRL<Fetcher<Data, K>>,
  options?: SWROptions<Data>,
): SWRResponse<Data> {
  // ─── Resolve config ───

  let providerConfig: import("../types/index.ts").SWRConfig | undefined;
  try {
    providerConfig = useContext(SWRConfigContext);
  } catch (e) {
    if (!isContextNotFoundError(e)) throw e;
    // No SWRProvider in tree - use defaults
    if (isDev()) {
      console.warn("[qwik-swr] No SWRProvider found in component tree. Using default config.");
    }
  }

  const resolved = resolveOptions(providerConfig, options);

  // ─── State (useStore) ───
  // QRL actions are assigned via useTask$ (not in render) to avoid
  // "State mutation inside render function" error.

  const state = useStore<SWRResponse<Data>>({
    data: resolved.fallbackData as Data | undefined,
    error: undefined,
    status: resolved.fallbackData != null ? "success" : "idle",
    fetchStatus: "idle",
    isLoading: false,
    isSuccess: resolved.fallbackData != null,
    isError: false,
    isValidating: false,
    isStale: false,
    revalidate$: undefined as unknown as QRL<() => Promise<Data | undefined>>,
    mutate$: undefined as unknown as SWRResponse<Data>["mutate$"],
  });

  // ─── Lifecycle ───

  useVisibleTask$(
    async ({ cleanup }) => {
      if (key === null || key === undefined || key === false) return;
      if (!resolved.enabled) return;

      const validKey = key as K;
      const hashed = hashKey(validKey);
      const fetcherFn = await fetcher.resolve();

      const observer = createObserver<Data>(hashed, validKey, state, resolved);

      setupFetchLifecycle(
        { hashedKey: hashed, rawKey: validKey, fetcherFn, observer, resolved },
        cleanup,
      );
    },
    { strategy: mapEagerness(resolved.eagerness) },
  );

  // ─── Mutations ───

  // Note: key is captured by value (not reactive). If key reactivity is added
  // in the future, this context must be updated when the key changes (SF-5).
  const mutationCtx: MutationContext<Data, K> = {
    key: key as K | null | undefined | false,
    state,
    resolved,
    fetcher,
  };

  const _mutate$ = $(
    (
      newData: Data | ((current: Data | undefined) => Data),
      mutateOptions?: { revalidate?: boolean },
    ) => performMutate(mutationCtx, newData, mutateOptions),
  );

  const _revalidate$ = $(() => performRevalidate(mutationCtx));

  // Assign QRLs to store outside render context (TaskEvent, not RenderEvent).
  useTask$(() => {
    state.revalidate$ = _revalidate$;
    state.mutate$ = _mutate$;
  });

  return state;
}
