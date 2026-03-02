import { useStore, useVisibleTask$, useTask$, $, isSignal, type QRL, type Signal } from "@builder.io/qwik";
import type {
  SWRKey,
  ValidKey,
  MaybeSignalSWRKey,
  SubscriptionOptions,
  SubscriptionResponse,
  SubscriptionStatus,
  Subscriber,
  SWRError,
} from "../types/index.ts";
import { hashKey } from "../utils/hash.ts";
import { generateId, isDev } from "../utils/env.ts";
import { isDisabledKey } from "../utils/resolve-key.ts";
import { subscriptionRegistry, type SubscriptionObserver } from "./subscription-registry.ts";
import type { ResolvedCallbacks } from "./subscription-connect.ts";

/**
 * Resolve QRL option callbacks once and return cached function references.
 */
async function resolveOptionCallbacks<Data>(
  options?: SubscriptionOptions<Data>,
): Promise<ResolvedCallbacks<Data>> {
  const onData = options?.onData$ ? await options.onData$.resolve() : undefined;
  const onError = options?.onError$ ? await options.onError$.resolve() : undefined;
  const onStatusChange = options?.onStatusChange$
    ? await options.onStatusChange$.resolve()
    : undefined;
  return { onData, onError, onStatusChange };
}

/**
 * Helper to update derived boolean state from SubscriptionStatus.
 */
function setStatusDerived(
  state: { isConnecting: boolean; isLive: boolean; isDisconnected: boolean },
  status: SubscriptionStatus,
): void {
  state.isConnecting = status === "connecting";
  state.isLive = status === "live";
  state.isDisconnected = status === "disconnected";
}

/**
 * Create a SubscriptionObserver that updates component state and invokes callbacks.
 * Extracted to avoid duplication between useVisibleTask$ and reconnect$.
 */
function createObserverForHook<Data>(
  observerId: string,
  state: SubscriptionResponse<Data>,
  callbacks: ResolvedCallbacks<Data>,
): SubscriptionObserver {
  return {
    id: observerId,
    onData: (data: unknown) => {
      state.data = data as Data;
      state.error = undefined;
      try {
        callbacks.onData?.(data as Data);
      } catch (err) {
        if (isDev()) {
          console.warn(`[qwik-swr] onData callback threw for observer="${observerId}":`, err);
        }
      }
    },
    onError: (error: SWRError) => {
      if (isDev()) {
        // eslint-disable-next-line no-console
        console.warn(`[qwik-swr] observer.onError observer="${observerId}"`, error);
      }
      state.error = error;
      try {
        callbacks.onError?.(error);
      } catch (err) {
        if (isDev()) {
          console.warn(`[qwik-swr] onError callback threw for observer="${observerId}":`, err);
        }
      }
    },
    onStatusChange: (status: SubscriptionStatus) => {
      if (isDev()) {
        // eslint-disable-next-line no-console
        console.log(
          `[qwik-swr] observer.onStatusChange observer="${observerId}" status="${status}"`,
        );
      }
      state.status = status;
      setStatusDerived(state, status);
      try {
        callbacks.onStatusChange?.(status);
      } catch (err) {
        if (isDev()) {
          console.warn(
            `[qwik-swr] onStatusChange callback threw for observer="${observerId}":`,
            err,
          );
        }
      }
    },
  };
}

/**
 * useSubscription - Real-time data subscription hook for Qwik.
 *
 * Uses SubscriptionRegistry to share connections across hooks with the same key.
 * Each hook maintains its own useStore state for UI independence.
 * The first hook for a key creates the connection; subsequent hooks join.
 * The last hook to unmount closes the connection.
 *
 * Supports Signal<SWRKey> for reactive key changes. When the Signal value
 * changes, the previous subscription is cleaned up and a new one starts.
 */
// Overload 1: valid key
export function useSubscription<Data, K extends ValidKey>(
  key: K,
  subscriber: QRL<Subscriber<Data, K>>,
  options?: SubscriptionOptions<Data>,
): SubscriptionResponse<Data>;
// Overload 2: disabled key
export function useSubscription<Data>(
  key: null | undefined | false,
  subscriber: QRL<Subscriber<Data, any>>,
  options?: SubscriptionOptions<Data>,
): SubscriptionResponse<Data>;
// Overload 3: runtime key
export function useSubscription<Data, K extends ValidKey = ValidKey>(
  key: SWRKey,
  subscriber: QRL<Subscriber<Data, K>>,
  options?: SubscriptionOptions<Data>,
): SubscriptionResponse<Data>;
// Overload 4: Signal key (reactive key changes)
export function useSubscription<Data, K extends ValidKey = ValidKey>(
  key: Signal<SWRKey>,
  subscriber: QRL<Subscriber<Data, K>>,
  options?: SubscriptionOptions<Data>,
): SubscriptionResponse<Data>;
// Implementation
export function useSubscription<Data, K extends ValidKey = ValidKey>(
  key: MaybeSignalSWRKey,
  subscriber: QRL<Subscriber<Data, K>>,
  options?: SubscriptionOptions<Data>,
): SubscriptionResponse<Data> {
  const maxRetries = options?.maxRetries ?? 10;
  const retryInterval = options?.retryInterval ?? 1000;
  const connectionTimeout = options?.connectionTimeout ?? 30_000;
  const keyIsSignal = isSignal(key);

  // Stable observer ID for this hook instance.
  const _ids = useStore({ observerId: generateId("sub-obs") });
  const observerId = _ids.observerId;

  // Mutable key reference for QRL actions
  const keyRef: { current: SWRKey } = {
    current: keyIsSignal ? key.value : (key as SWRKey),
  };

  // UI state (useStore) - each hook instance has its own state.
  const state = useStore<SubscriptionResponse<Data>>({
    data: undefined as Data | undefined,
    error: undefined as SWRError | undefined,
    status: "connecting" as SubscriptionStatus,
    isConnecting: true,
    isLive: false,
    isDisconnected: false,
    unsubscribe$: undefined as unknown as QRL<() => void>,
    reconnect$: undefined as unknown as QRL<() => void>,
  });

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(
    async ({ cleanup, track }) => {
      const currentKey: SWRKey = keyIsSignal
        ? track(key as Signal<SWRKey>)
        : (key as SWRKey);

      // Update keyRef for QRL actions
      keyRef.current = currentKey;

      if (isDev()) {
        // eslint-disable-next-line no-console
        console.log(
          `[qwik-swr] useVisibleTask$ BODY observer="${observerId}" key="${String(currentKey)}"`,
        );
      }

      // Null key: don't subscribe
      if (isDisabledKey(currentKey)) {
        state.status = "disconnected";
        state.isConnecting = false;
        state.isDisconnected = true;
        state.isLive = false;
        return;
      }

      const hashed = hashKey(currentKey as ValidKey);
      const subscriberFn = await subscriber.resolve();
      const callbacks = await resolveOptionCallbacks(options);
      const observer = createObserverForHook(observerId, state, callbacks);

      if (isDev()) {
        // eslint-disable-next-line no-console
        console.log(`[qwik-swr] ATTACH observer="${observerId}" key="${hashed}"`);
      }
      subscriptionRegistry.attach(hashed, currentKey as ValidKey, observer, subscriberFn, {
        maxRetries,
        retryInterval,
        connectionTimeout,
      });

      cleanup(() => {
        if (isDev()) {
          // eslint-disable-next-line no-console
          console.warn(
            `[qwik-swr] useVisibleTask$ CLEANUP observer="${observerId}" key="${String(currentKey)}"`,
          );
        }
        subscriptionRegistry.detach(hashed, observerId);
        state.status = "disconnected";
        state.isConnecting = false;
        state.isLive = false;
        state.isDisconnected = true;
      });
    },
    { strategy: "document-ready" },
  );

  // Define QRLs in component body, assign to store via useTask$ to avoid
  // render-time mutation error.
  const _unsubscribe$ = $(() => {
    const currentKey = keyRef.current;
    if (!isDisabledKey(currentKey)) {
      const hashed = hashKey(currentKey as ValidKey);
      subscriptionRegistry.detach(hashed, observerId);
    }
    state.status = "disconnected";
    state.isConnecting = false;
    state.isLive = false;
    state.isDisconnected = true;
  });

  const _reconnect$ = $(async () => {
    const currentKey = keyRef.current;
    if (isDisabledKey(currentKey)) return;

    const hashed = hashKey(currentKey as ValidKey);
    state.error = undefined;

    const existingStatus = subscriptionRegistry.getStatus(hashed);
    if (existingStatus !== null) {
      // Connection still exists in registry: reconnect the shared connection
      await subscriptionRegistry.reconnect(hashed);
    } else {
      // Connection was fully closed: re-resolve + re-attach
      subscriptionRegistry.detach(hashed, observerId);

      const subscriberFn = await subscriber.resolve();
      const callbacks = await resolveOptionCallbacks(options);
      const observer = createObserverForHook(observerId, state, callbacks);

      subscriptionRegistry.attach(hashed, currentKey as ValidKey, observer, subscriberFn, {
        maxRetries,
        retryInterval,
        connectionTimeout,
      });
    }
  });

  // Assign QRLs to store outside render context (TaskEvent, not RenderEvent).
  useTask$(() => {
    if (isDev()) {
      // eslint-disable-next-line no-console
      console.log(`[qwik-swr] useTask$ RUN observer="${observerId}"`);
    }
    state.unsubscribe$ = _unsubscribe$;
    state.reconnect$ = _reconnect$;
  });

  return state;
}
