import { vi } from "vitest";
import type { HashedKey, ResolvedQueryConfig, FetcherCtx } from "../../src/types/index.ts";
import type { Observer } from "../../src/cache/types.ts";

// ===============================================================
// HashedKey helper - cast plain strings to HashedKey in tests
// ===============================================================

export function asHK(s: string): HashedKey {
  return s as HashedKey;
}

// ===============================================================
// makeObserver
// ===============================================================

let observerIdCounter = 0;

export function resetObserverIdCounter(): void {
  observerIdCounter = 0;
}

export function makeObserver<Data = unknown>(
  hashedKey: HashedKey,
  overrides: Partial<Observer<Data>> = {},
): Observer<Data> {
  return {
    id: `test-observer-${++observerIdCounter}`,
    hashedKey,
    lastRawKey: hashedKey,
    hasData: false,
    onData: vi.fn(),
    onError: vi.fn(),
    onFetchStatusChange: vi.fn(),
    ...overrides,
  };
}

// ===============================================================
// makeOptions
// ===============================================================

export function makeOptions(overrides: Partial<ResolvedQueryConfig> = {}): ResolvedQueryConfig {
  return {
    enabled: true,
    eagerness: "visible",
    staleTime: 30_000,
    cacheTime: 300_000,
    revalidateOn: ["focus", "reconnect"],
    refreshInterval: 0,
    dedupingInterval: 2_000,
    retry: 3,
    retryInterval: 1_000,
    timeout: 30_000,
    ...overrides,
  } as ResolvedQueryConfig;
}

// ===============================================================
// makeFetcher
// ===============================================================

export function makeFetcher<Data>(
  data: Data,
  delay = 0,
): ReturnType<typeof vi.fn<(ctx: FetcherCtx) => Promise<Data>>> {
  return vi.fn(
    (_ctx: FetcherCtx) =>
      new Promise<Data>((resolve) => {
        if (delay > 0) {
          setTimeout(() => resolve(data), delay);
        } else {
          // Resolve on next microtask
          Promise.resolve().then(() => resolve(data));
        }
      }),
  );
}

// ===============================================================
// makeFailingFetcher
// ===============================================================

export function makeFailingFetcher(
  error: Error,
  delay = 0,
): ReturnType<typeof vi.fn<(ctx: FetcherCtx) => Promise<never>>> {
  return vi.fn(
    (_ctx: FetcherCtx) =>
      new Promise<never>((_, reject) => {
        if (delay > 0) {
          setTimeout(() => reject(error), delay);
        } else {
          Promise.resolve().then(() => reject(error));
        }
      }),
  );
}

// ===============================================================
// flush
// ===============================================================

export async function flush(): Promise<void> {
  // Multiple rounds to handle chained promises
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}
