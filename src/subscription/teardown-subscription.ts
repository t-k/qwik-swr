import { subscriptionRegistry } from "./subscription-registry.ts";

/**
 * Teardown all subscription state.
 *
 * Closes all active connections, clears sync state, and resets the registry.
 * Call this when cleaning up subscription resources (e.g. in tests or app shutdown).
 */
export function teardownSubscription(): void {
  subscriptionRegistry._reset();
}
