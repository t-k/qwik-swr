import type { SWRKey } from "../types/index.ts";

/**
 * Check if a key is disabled (null, undefined, or false).
 * Disabled keys prevent fetching / subscription.
 */
export function isDisabledKey(key: SWRKey): key is null | undefined | false {
  return key === null || key === undefined || key === false;
}
