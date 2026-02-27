import {
  type Component,
  component$,
  Slot,
  createContextId,
  useContextProvider,
} from "@builder.io/qwik";
import type { SWRConfig } from "../types/index.ts";

/**
 * Context ID for SWR global configuration.
 * Used internally by useSWR to resolve provider-level defaults.
 */
export const SWRConfigContext = createContextId<SWRConfig>("qwik-swr.config");

/**
 * SWRProvider component.
 *
 * Wraps the application (or a subtree) to provide global SWR configuration
 * defaults. Child useSWR hooks will inherit these settings, with hook-level
 * options taking priority.
 *
 * @example
 * ```tsx
 * <SWRProvider config={{ freshness: 'slow', retry: 5 }}>
 *   <Slot />
 * </SWRProvider>
 * ```
 */
export const SWRProvider: Component<{ config: SWRConfig }> = component$((props) => {
  useContextProvider(SWRConfigContext, props.config);
  return <Slot />;
});
