// Subscription entry point
// Import from "qwik-swr/subscription" to use subscription features.

export { useSubscription } from "./use-subscription.ts";
export { subscriptionRegistry, type SubscriptionObserver } from "./subscription-registry.ts";

// Subscription sync initialization
export { initSubscriptionSync } from "./init-subscription-sync.ts";

// Subscription teardown
export { teardownSubscription } from "./teardown-subscription.ts";

// Re-export sync types for convenience
export type { SubscriptionSyncConfig, SubscriptionSyncApi } from "./subscription-sync.ts";
