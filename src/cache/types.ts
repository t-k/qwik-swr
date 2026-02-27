import type { CacheEntry, FetchStatus, HashedKey, SWRError, ValidKey } from "../types/index.ts";

// ═══════════════════════════════════════════════════════════════
// Internal Cache Types
// ═══════════════════════════════════════════════════════════════

export interface InFlightEntry<Data = unknown> {
  hashedKey: HashedKey;
  promise: Promise<Data>;
  abortController: AbortController;
  requestId: number;
  observerCount: number;
}

export interface CooldownRecord {
  hashedKey: HashedKey;
  completedAt: number;
  timerId: ReturnType<typeof setTimeout>;
}

export interface Observer<Data = unknown> {
  id: string;
  hashedKey: HashedKey;
  lastRawKey: ValidKey;
  hasData: boolean;
  onData: (entry: CacheEntry<Data>) => void;
  onError: (error: SWRError) => void;
  onFetchStatusChange: (status: FetchStatus) => void;
}
