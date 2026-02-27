import type { RevalidateTrigger } from "../types/index.ts";
import { store } from "./store.ts";
import { isDev } from "../utils/env.ts";

const FOCUS_DEBOUNCE_MS = 100;

// ═══════════════════════════════════════════════════════════════
// Global subscription state: single listener per trigger type
// ═══════════════════════════════════════════════════════════════

interface SubscriptionState {
  subscribers: Map<symbol, () => void>;
  cleanup: (() => void) | null;
}

const focusState: SubscriptionState = {
  subscribers: new Map(),
  cleanup: null,
};

const reconnectState: SubscriptionState = {
  subscribers: new Map(),
  cleanup: null,
};

/**
 * Initialize event manager for revalidation triggers.
 *
 * Uses global subscription pattern: single listener shared by all subscribers.
 * First subscriber registers the global listener, last unsubscriber removes it.
 *
 * Returns a cleanup function that removes the subscription.
 * SSR-safe: returns noop if window is undefined.
 */
export function initEventManager(
  triggers: readonly RevalidateTrigger[],
  handler: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  const cleanups: (() => void)[] = [];

  for (const trigger of triggers) {
    if (trigger === "focus") {
      cleanups.push(subscribeFocus(handler));
    } else if (trigger === "reconnect") {
      cleanups.push(subscribeReconnect(handler));
    }
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * Register a single event handler for a specific trigger.
 * Returns a cleanup function.
 */
export function registerEventHandler(trigger: RevalidateTrigger, handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  if (trigger === "focus") {
    return subscribeFocus(handler);
  }
  if (trigger === "reconnect") {
    return subscribeReconnect(handler);
  }
  return () => {};
}

// ═══════════════════════════════════════════════════════════════
// Focus subscription
// ═══════════════════════════════════════════════════════════════

function subscribeFocus(handler: () => void): () => void {
  const id = Symbol();
  focusState.subscribers.set(id, handler);

  // First subscriber: register global listener
  if (focusState.subscribers.size === 1) {
    focusState.cleanup = registerFocusListener();
  }

  return () => {
    focusState.subscribers.delete(id);
    // Last unsubscriber: remove global listener
    if (focusState.subscribers.size === 0 && focusState.cleanup) {
      focusState.cleanup();
      focusState.cleanup = null;
    }
  };
}

function registerFocusListener(): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const notifyAll = () => {
    for (const handler of focusState.subscribers.values()) {
      try {
        handler();
      } catch (err) {
        if (isDev()) {
          console.warn("[qwik-swr] focus revalidation handler threw:", err);
        }
      }
    }
  };

  const debouncedHandler = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      notifyAll();
    }, FOCUS_DEBOUNCE_MS);
  };

  const visibilityHandler = () => {
    if (document.visibilityState === "visible") {
      debouncedHandler();
    }
  };

  window.addEventListener("focus", debouncedHandler);
  document.addEventListener("visibilitychange", visibilityHandler);

  return () => {
    window.removeEventListener("focus", debouncedHandler);
    document.removeEventListener("visibilitychange", visibilityHandler);
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// Reconnect subscription
// ═══════════════════════════════════════════════════════════════

function subscribeReconnect(handler: () => void): () => void {
  const id = Symbol();
  reconnectState.subscribers.set(id, handler);

  // First subscriber: register global listener
  if (reconnectState.subscribers.size === 1) {
    reconnectState.cleanup = registerReconnectListener();
  }

  return () => {
    reconnectState.subscribers.delete(id);
    // Last unsubscriber: remove global listener
    if (reconnectState.subscribers.size === 0 && reconnectState.cleanup) {
      reconnectState.cleanup();
      reconnectState.cleanup = null;
    }
  };
}

function registerReconnectListener(): () => void {
  const notifyAll = () => {
    for (const handler of reconnectState.subscribers.values()) {
      try {
        handler();
      } catch (err) {
        if (isDev()) {
          console.warn("[qwik-swr] reconnect revalidation handler threw:", err);
        }
      }
    }
  };

  const onOnline = () => {
    store.setOnline(true);
    notifyAll();
  };
  const onOffline = () => {
    store.setOnline(false);
  };

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}

// ═══════════════════════════════════════════════════════════════
// Test utilities
// ═══════════════════════════════════════════════════════════════

/** @internal Reset state for testing */
export function _resetEventManagerState(): void {
  focusState.subscribers.clear();
  if (focusState.cleanup) {
    focusState.cleanup();
    focusState.cleanup = null;
  }
  reconnectState.subscribers.clear();
  if (reconnectState.cleanup) {
    reconnectState.cleanup();
    reconnectState.cleanup = null;
  }
}

/** @internal Get subscriber counts for testing */
export function _getSubscriberCounts(): { focus: number; reconnect: number } {
  return {
    focus: focusState.subscribers.size,
    reconnect: reconnectState.subscribers.size,
  };
}
