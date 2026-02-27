import type { SubscriptionStatus, SWRError, ValidKey } from "../types/index.ts";
import { toSWRError } from "../utils/error.ts";
import { isDev } from "../utils/env.ts";

// ═══════════════════════════════════════════════════════════════
// ConnectionContext: Callback-based interface to decouple from Qwik Signals
// ═══════════════════════════════════════════════════════════════

type SubscriberResult = { unsubscribe: () => void } | Promise<{ unsubscribe: () => void }>;

type SubscriberFn<Data, K> = (
  key: K,
  callbacks: {
    onData: (data: Data) => void;
    onError: (error: Error | SWRError) => void;
  },
) => SubscriberResult;

export interface ConnectionContext<Data, K extends ValidKey = ValidKey> {
  key: K;
  subscriberFn: SubscriberFn<Data, K>;
  maxRetries: number;
  retryInterval: number;
  // State management callbacks
  onStatusChange: (status: SubscriptionStatus) => void;
  onData: (data: Data) => void;
  onError: (error: SWRError) => void;
  // Ref management
  getCancelled: () => boolean;
  getRetryCount: () => number;
  setRetryCount: (n: number) => void;
  setUnsubFn: (fn: (() => void) | null) => void;
  getUnsubFn: () => (() => void) | null;
  setRetryTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  // Optional external notifications (options.onXxx$ callbacks, already resolved)
  notifyOnData?: (data: Data) => void;
  notifyOnError?: (error: SWRError) => void;
  notifyOnStatusChange?: (status: SubscriptionStatus) => void;
}

// ═══════════════════════════════════════════════════════════════
// SubscriptionRefs / SubscriptionState: Shared parameter types
// ═══════════════════════════════════════════════════════════════

export interface SubscriptionRefs {
  getCancelled: () => boolean;
  getRetryCount: () => number;
  setRetryCount: (n: number) => void;
  setUnsubFn: (fn: (() => void) | null) => void;
  getUnsubFn: () => (() => void) | null;
  setRetryTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
}

export interface SubscriptionState<Data> {
  data: Data | undefined;
  error: SWRError | undefined;
  status: SubscriptionStatus;
  isConnecting: boolean;
  isLive: boolean;
  isDisconnected: boolean;
}

export interface ResolvedCallbacks<Data> {
  onData?: (data: Data) => void;
  onError?: (error: SWRError) => void;
  onStatusChange?: (status: SubscriptionStatus) => void;
}

// ═══════════════════════════════════════════════════════════════
// buildConnectionContext: Eliminate duplication between useVisibleTask$ and reconnect$
// ═══════════════════════════════════════════════════════════════

export function buildConnectionContext<Data, K extends ValidKey = ValidKey>(params: {
  key: K;
  subscriberFn: SubscriberFn<Data, K>;
  maxRetries: number;
  retryInterval: number;
  state: SubscriptionState<Data>;
  refs: SubscriptionRefs;
  callbacks?: ResolvedCallbacks<Data>;
}): ConnectionContext<Data, K> {
  const { state, refs, callbacks } = params;

  const setStatus = (s: SubscriptionStatus) => {
    state.status = s;
    state.isConnecting = s === "connecting";
    state.isLive = s === "live";
    state.isDisconnected = s === "disconnected";
  };

  return {
    key: params.key,
    subscriberFn: params.subscriberFn,
    maxRetries: params.maxRetries,
    retryInterval: params.retryInterval,
    onStatusChange: setStatus,
    onData: (d) => {
      state.data = d;
      state.error = undefined;
    },
    onError: (e) => {
      state.error = e;
    },
    ...refs,
    notifyOnData: callbacks?.onData
      ? (d) => {
          try {
            callbacks.onData!(d);
          } catch (err) {
            if (isDev()) {
              console.warn("[qwik-swr] onData$ callback error:", err);
            }
          }
        }
      : undefined,
    notifyOnError: callbacks?.onError
      ? (e) => {
          try {
            callbacks.onError!(e);
          } catch (err) {
            if (isDev()) {
              console.warn("[qwik-swr] onError$ callback error:", err);
            }
          }
        }
      : undefined,
    notifyOnStatusChange: callbacks?.onStatusChange
      ? (s) => {
          try {
            callbacks.onStatusChange!(s);
          } catch (err) {
            if (isDev()) {
              console.warn("[qwik-swr] onStatusChange$ callback error:", err);
            }
          }
        }
      : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════
// handleResult: Process sync/async subscriber results
// ═══════════════════════════════════════════════════════════════

export function handleResult(
  result: SubscriberResult,
  getCancelled: () => boolean,
  setUnsubFn: (fn: (() => void) | null) => void,
): void | Promise<void> {
  if (
    result instanceof Promise ||
    (result && typeof (result as unknown as Promise<unknown>).then === "function")
  ) {
    return (result as Promise<{ unsubscribe: () => void }>).then((resolved) => {
      if (getCancelled()) {
        resolved.unsubscribe();
      } else {
        setUnsubFn(resolved.unsubscribe);
      }
    });
  }
  const syncResult = result as { unsubscribe: () => void };
  if (getCancelled()) {
    syncResult.unsubscribe();
  } else {
    setUnsubFn(syncResult.unsubscribe);
  }
}

// ═══════════════════════════════════════════════════════════════
// createConnection: Shared connection logic for useVisibleTask$ and reconnect$
// ═══════════════════════════════════════════════════════════════

export async function createConnection<Data, K extends ValidKey = ValidKey>(
  ctx: ConnectionContext<Data, K>,
): Promise<void> {
  if (ctx.getCancelled()) return;
  ctx.onStatusChange("connecting");

  try {
    const result = ctx.subscriberFn(ctx.key, {
      onData: (d: Data) => {
        if (ctx.getCancelled()) return;
        ctx.onData(d);

        if (ctx.getRetryCount() > 0 || ctx.onStatusChange) {
          ctx.setRetryCount(0);
          ctx.onStatusChange("live");
        }

        ctx.notifyOnData?.(d);
      },
      onError: (err: SWRError | Error) => {
        if (ctx.getCancelled()) return;
        // Convert to SWRError if raw Error was passed (backward compat)
        const swrError =
          "type" in err && "timestamp" in err
            ? (err as SWRError)
            : toSWRError(err, ctx.getRetryCount());
        ctx.onError(swrError);

        ctx.notifyOnError?.(swrError);

        ctx.setRetryCount(ctx.getRetryCount() + 1);

        if (ctx.getRetryCount() > ctx.maxRetries) {
          ctx.onStatusChange("disconnected");
          ctx.notifyOnStatusChange?.("disconnected");
          return;
        }

        ctx.onStatusChange("connecting");
        ctx.notifyOnStatusChange?.("connecting");

        const delay = ctx.retryInterval * 2 ** (ctx.getRetryCount() - 1);
        ctx.setRetryTimer(
          setTimeout(() => {
            if (!ctx.getCancelled()) {
              ctx.getUnsubFn()?.();
              ctx.setUnsubFn(null);
              createConnection(ctx);
            }
          }, delay),
        );
      },
    });

    await handleResult(result, ctx.getCancelled, ctx.setUnsubFn);
  } catch (err) {
    if (ctx.getCancelled()) return;
    const swrError = toSWRError(err, ctx.getRetryCount());
    ctx.onError(swrError);
    ctx.setRetryCount(ctx.getRetryCount() + 1);

    if (ctx.getRetryCount() > ctx.maxRetries) {
      ctx.onStatusChange("disconnected");
      return;
    }

    ctx.onStatusChange("connecting");
    const delay = ctx.retryInterval * 2 ** (ctx.getRetryCount() - 1);
    ctx.setRetryTimer(
      setTimeout(() => {
        if (!ctx.getCancelled()) createConnection(ctx);
      }, delay),
    );
  }
}
