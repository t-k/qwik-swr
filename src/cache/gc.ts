import { store } from "./store.ts";
import type { GCConfig } from "../types/index.ts";

let gcTimer: ReturnType<typeof setInterval> | null = null;

export function startGC(config?: GCConfig): void {
  // Don't start in SSR environment or non-browser contexts (SF-22)
  // Check both window (Node SSR) and document (Deno/Workers without DOM)
  if (typeof window === "undefined" || typeof document === "undefined") return;
  stopGC();
  if (config?.enabled === false) return;
  const interval = config?.intervalMs ?? 60000;

  // Capture config for runGC
  const gcConfig = config;
  gcTimer = setInterval(() => runGC(gcConfig), interval);
}

export function stopGC(): void {
  if (gcTimer !== null) {
    clearInterval(gcTimer);
    gcTimer = null;
  }
}

/**
 * Run garbage collection.
 *
 * Phase 1: Evict entries that exceed cacheTime (existing behavior).
 * Phase 2: If maxEntries is set, evict oldest orphan entries to bring count within limit.
 * memoryAware: Scale maxEntries down based on navigator.deviceMemory for low-memory devices.
 */
export function runGC(config?: GCConfig): void {
  const now = Date.now();
  const keys = store.keys();

  // Phase 1: Evict expired entries (existing behavior)
  // Track evicted keys to avoid redundant re-scan in Phase 2 (SF-7)
  const evictedInPhase1 = new Set<string>();
  for (const hashedKey of keys) {
    if (store.getObserverCount(hashedKey) > 0) continue;

    const entry = store.getCache(hashedKey);
    if (!entry) continue;

    const age = now - entry.timestamp;
    const cacheTime = store.getCacheTime(hashedKey);
    if (age > cacheTime) {
      store.deleteCache(hashedKey);
      evictedInPhase1.add(hashedKey);
    }
  }

  // Phase 2: maxEntries enforcement
  let maxEntries = config?.maxEntries;
  if (maxEntries === undefined) return;

  // memoryAware: scale maxEntries based on navigator.deviceMemory
  if (config?.memoryAware && typeof navigator !== "undefined" && "deviceMemory" in navigator) {
    const deviceMemory = (navigator as { deviceMemory?: number }).deviceMemory;
    if (typeof deviceMemory === "number" && deviceMemory > 0) {
      // Scale: deviceMemory is in GB (typically 0.25, 0.5, 1, 2, 4, 8)
      // Use 8GB as baseline (no scaling). Lower memory = lower limit.
      const scale = Math.min(deviceMemory / 8, 1);
      maxEntries = Math.max(1, Math.floor(maxEntries * scale));
    }
  }

  // Reuse Phase 1 keys, filtering out evicted ones (SF-7: avoid second store.keys())
  const remainingKeys = keys.filter((k) => !evictedInPhase1.has(k));
  if (remainingKeys.length <= maxEntries) return;

  // Collect orphan entries (no active observers) with their timestamps
  const orphans: Array<{ key: string; timestamp: number }> = [];
  for (const hashedKey of remainingKeys) {
    if (store.getObserverCount(hashedKey) > 0) continue;
    const entry = store.getCache(hashedKey);
    if (entry) {
      orphans.push({ key: hashedKey, timestamp: entry.timestamp });
    }
  }

  // Sort orphans by timestamp ascending (oldest first)
  orphans.sort((a, b) => a.timestamp - b.timestamp);

  // Evict oldest orphans until we're within limit
  const toEvict = remainingKeys.length - maxEntries;
  const evictCount = Math.min(toEvict, orphans.length);
  for (let i = 0; i < evictCount; i++) {
    store.deleteCache(orphans[i]!.key);
  }
}
