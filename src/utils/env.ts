/**
 * Generate a unique identifier string.
 * Uses crypto.randomUUID() if available, falling back to
 * crypto.getRandomValues() hex, then Date.now()+Math.random().
 *
 * @param prefix - Optional prefix prepended as "{prefix}-"
 */
export function generateId(prefix?: string): string {
  let id: string;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    id = crypto.randomUUID();
  } else if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    id = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  } else {
    if (isDev()) {
      console.warn(
        "[qwik-swr] crypto API unavailable; falling back to Math.random() for ID generation. " +
          "Tab IDs may not be unique in rare cases.",
      );
    }
    id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return prefix ? `${prefix}-${id}` : id;
}

/**
 * Check if a value is a thenable (has a .then method).
 * Used instead of `instanceof Promise` to handle non-native thenables
 * from async CacheStorage backends and subscriber results.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value != null && typeof (value as Record<string, unknown>).then === "function";
}

/**
 * Check if running in development mode.
 * Returns true if import.meta.env.DEV is truthy or NODE_ENV is "development".
 */
export function isDev(): boolean {
  // Check Vite/bundler env first
  if (typeof import.meta !== "undefined" && (import.meta as any).env) {
    return !!(import.meta as any).env.DEV;
  }
  // Fallback for Node.js environments (SSR)
  // Use globalThis to avoid TypeScript errors without @types/node
  const proc = (globalThis as any).process;
  if (typeof proc !== "undefined" && proc.env) {
    return proc.env.NODE_ENV === "development";
  }
  return false;
}
