import type { CacheEntry } from "../src/types/index.ts";

/**
 * Serialize a CacheEntry for storage.
 * Strips `error.original` (non-serializable) before storing.
 */
export function toStorable<Data>(entry: CacheEntry<Data>): CacheEntry<Data> {
  if (!entry.error) return entry;
  const { original: _, ...safeError } = entry.error as any;
  return { ...entry, error: safeError };
}
