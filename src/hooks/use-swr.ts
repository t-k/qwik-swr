import { useStore, useVisibleTask$, useTask$, useContext, $, isSignal } from "@builder.io/qwik";
import type { QRL, Signal } from "@builder.io/qwik";
import type {
  SWRKey,
  ValidKey,
  Fetcher,
  SWROptions,
  SWRResponse,
  MaybeSignalSWRKey,
} from "../types/index.ts";
import { SWRConfigContext } from "../provider/swr-provider.tsx";
import { resolveOptions } from "../utils/resolve-options.ts";
import { hashKey } from "../utils/hash.ts";
import { mapEagerness } from "./helpers.ts";
import { createObserver } from "./create-observer.ts";
import { startFetchLifecycle, type ActiveLifecycle } from "./lifecycle-state.ts";
import { performMutate, performRevalidate, type MutationContext } from "./create-mutations.ts";
import { isContextNotFoundError } from "../utils/context-error.ts";
import { isDev } from "../utils/env.ts";
import { isDisabledKey } from "../utils/resolve-key.ts";

// ═══════════════════════════════════════════════════════════════
// useSWR hook
// ═══════════════════════════════════════════════════════════════

/**
 * Overload 1: Valid key with type inference
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

/** Overload 4: Signal key (reactive key changes) */
export function useSWR<Data, K extends ValidKey = ValidKey>(
  key: Signal<SWRKey>,
  fetcher: QRL<Fetcher<Data, K>>,
  options?: SWROptions<Data>,
): SWRResponse<Data>;

/** Implementation */
export function useSWR<Data, K extends ValidKey = ValidKey>(
  key: MaybeSignalSWRKey,
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
  const keyIsSignal = isSignal(key);

  // ─── State (useStore) ───

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

  // ─── Key reference (shared with MutationContext) ───
  // Mutable object so mutations always read the latest key.
  const keyRef: { current: K | null | undefined | false } = {
    current: (keyIsSignal ? key.value : key) as K | null | undefined | false,
  };

  // ─── Lifecycle ───

  useVisibleTask$(
    async ({ cleanup, track }) => {
      // For Signal keys, track changes so this task re-runs on key change
      const currentKey: SWRKey = keyIsSignal ? track(key as Signal<SWRKey>) : (key as SWRKey);

      // Update keyRef for mutation context
      keyRef.current = currentKey as K | null | undefined | false;

      // If disabled, reset state (keepPreviousData does NOT preserve on disabled)
      if (isDisabledKey(currentKey) || !resolved.enabled) {
        resetStateToIdle(state, resolved);
        return;
      }

      const validKey = currentKey as K;
      const hashed = hashKey(validKey);
      const fetcherFn = await fetcher.resolve();

      // If keepPreviousData is false, reset state before fetching new key
      if (!resolved.keepPreviousData) {
        resetStateToIdle(state, resolved);
      }
      // If keepPreviousData is true, we leave data/status untouched until new data arrives

      const observer = createObserver<Data>(hashed, validKey, state, resolved);

      const lifecycle: ActiveLifecycle<Data> = startFetchLifecycle({
        hashedKey: hashed,
        rawKey: validKey,
        fetcherFn,
        observer,
        resolved,
      });

      cleanup(() => lifecycle.teardown());
    },
    { strategy: mapEagerness(resolved.eagerness) },
  );

  // ─── Mutations ───

  const mutationCtx: MutationContext<Data, K> = {
    keyRef,
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

/**
 * Reset state to idle (used on disabled key or key change without keepPreviousData).
 */
function resetStateToIdle<Data>(
  state: SWRResponse<Data>,
  resolved: import("../types/index.ts").ResolvedSWROptions<Data>,
): void {
  state.data = resolved.fallbackData as Data | undefined;
  state.error = undefined;
  state.status = resolved.fallbackData != null ? "success" : "idle";
  state.fetchStatus = "idle";
  state.isLoading = false;
  state.isSuccess = resolved.fallbackData != null;
  state.isError = false;
  state.isValidating = false;
  state.isStale = false;
}
