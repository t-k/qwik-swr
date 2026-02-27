import { store } from "./cache/store.ts";
import { stopGC } from "./cache/gc.ts";
import { timerCoordinator } from "./cache/timer-coordinator.ts";
import { _resetEventManagerState } from "./cache/event-manager.ts";

/**
 * Teardown all qwik-swr state.
 *
 * Resets the cache store, stops GC, resets timer coordinator, and
 * clears event manager subscriptions.
 *
 * Does NOT reset subscription state — use `teardownSubscription()`
 * from "qwik-swr/subscription" for that.
 *
 * Useful for tests and app shutdown.
 */
export function teardownSWR(): void {
  store._reset();
  stopGC();
  timerCoordinator._reset();
  _resetEventManagerState();
}
