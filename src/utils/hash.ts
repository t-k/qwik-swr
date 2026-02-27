import type { ValidKey } from "../types/index.ts";

/**
 * Hash a valid key into a unique string with type prefix.
 * - String keys: "s:{key}"
 * - Array keys:  "a:{JSON.stringify(key)}"
 *
 * Type prefix prevents collision between string "1" and array [1].
 */
export function hashKey(key: ValidKey): string {
  if (typeof key === "string") {
    return `s:${key}`;
  }
  try {
    return `a:${JSON.stringify(key)}`;
  } catch {
    // Fallback for circular references or non-serializable values
    return `a:${String(key)}`;
  }
}
