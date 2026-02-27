import { useStore, useTask$, $, type QRL } from "@builder.io/qwik";
import type {
  MutationOptions,
  MutationResponse,
  SWRError,
  CacheEntry,
  ValidKey,
  HashedKey,
} from "../types/index.ts";
import { store } from "../cache/store.ts";
import { cache } from "../cache/cache-api.ts";
import { hashKey } from "../utils/hash.ts";
import { toSWRError } from "../utils/error.ts";

/**
 * useMutation - Data mutation hook for Qwik.
 *
 * Each instance maintains independent state (isPending, isError, etc.).
 * Supports optimistic updates with automatic rollback on error.
 * Supports invalidateKeys for cache revalidation after success.
 */
export function useMutation<Data, Variables = void>(
  mutationFn: QRL<(variables: Variables) => Promise<Data>>,
  options?: MutationOptions<Data, Variables>,
): MutationResponse<Data, Variables> {
  // Independent state per instance.
  // QRL actions are assigned via useTask$ (not in render) to avoid
  // "State mutation inside render function" error.
  const state = useStore<MutationResponse<Data, Variables>>({
    data: undefined as Data | undefined,
    error: undefined as SWRError | undefined,
    variables: undefined as Variables | undefined,
    isIdle: true,
    isPending: false,
    isSuccess: false,
    isError: false,
    mutate$: undefined as unknown as QRL<(variables: Variables) => void>,
    mutateAsync$: undefined as unknown as QRL<(variables: Variables) => Promise<Data>>,
    reset$: undefined as unknown as QRL<() => void>,
  });

  // Track the latest mutation request to handle concurrent calls (SF-6)
  // useStore ensures the value survives QRL serialization boundaries
  const _mutationTracker = useStore({ latestMutationId: 0 });

  const _mutateAsync$ = $(async (vars: Variables): Promise<Data> => {
    const mutationId = ++_mutationTracker.latestMutationId;

    // Set pending state
    state.variables = vars;
    state.isIdle = false;
    state.isPending = true;
    state.isSuccess = false;
    state.isError = false;
    state.error = undefined;

    // Optimistic update: save snapshot and apply immediately
    let snapshot: { hashedKey: HashedKey; previousEntry: CacheEntry | null } | null = null;

    if (options?.optimisticUpdate) {
      const { key, updater$ } = options.optimisticUpdate;
      if (key !== null && key !== undefined && key !== false) {
        const hashed = hashKey(key as ValidKey);
        const previousEntry = store.getCache(hashed);
        snapshot = { hashedKey: hashed, previousEntry };

        // Apply optimistic data immediately
        const currentData = previousEntry?.data;
        const updaterFn = await updater$.resolve();
        const optimisticData = updaterFn(currentData as Data | undefined, vars);
        store.setCache(hashed, { data: optimisticData, timestamp: Date.now() });
      }
    }

    try {
      const fn = await mutationFn.resolve();
      const result = await fn(vars);

      // Success state (only update if this is still the latest mutation)
      if (mutationId === _mutationTracker.latestMutationId) {
        state.data = result;
        state.isPending = false;
        state.isSuccess = true;
        state.isError = false;
      }

      // Discard snapshot (no rollback needed)
      snapshot = null;

      // Invalidate keys
      if (options?.invalidateKeys) {
        for (const k of options.invalidateKeys) {
          cache.revalidate(k);
        }
      }

      // Call onSuccess$ callback
      if (options?.onSuccess$) {
        const onSuccess = await options.onSuccess$.resolve();
        onSuccess(result, vars);
      }

      return result;
    } catch (e) {
      // Error state (only update if this is still the latest mutation)
      const swrError = toSWRError(e);
      if (mutationId === _mutationTracker.latestMutationId) {
        state.error = swrError;
        state.isPending = false;
        state.isError = true;
        state.isSuccess = false;
      }

      // Rollback optimistic update only if no newer mutation has started on the same key.
      // If another mutation has already applied its own optimistic update, rolling back
      // would overwrite the newer mutation's data.
      if (snapshot && mutationId === _mutationTracker.latestMutationId) {
        if (snapshot.previousEntry) {
          store.setCache(snapshot.hashedKey, snapshot.previousEntry);
        } else {
          store.deleteCache(snapshot.hashedKey);
        }
      }

      // Call onError$ callback
      if (options?.onError$) {
        const onError = await options.onError$.resolve();
        onError(swrError, vars);
      }

      throw swrError;
    }
  });

  const _mutate$ = $(async (vars: Variables): Promise<void> => {
    try {
      const fn = await _mutateAsync$.resolve();
      await fn(vars);
    } catch {
      // fire-and-forget: swallow error (state is tracked via store)
    }
  });

  const _reset$ = $(() => {
    state.data = undefined;
    state.error = undefined;
    state.variables = undefined;
    state.isIdle = true;
    state.isPending = false;
    state.isSuccess = false;
    state.isError = false;
  });

  // Assign QRLs to store outside render context (TaskEvent, not RenderEvent).
  useTask$(() => {
    state.mutate$ = _mutate$;
    state.mutateAsync$ = _mutateAsync$;
    state.reset$ = _reset$;
  });

  return state;
}
