import type {
  Status,
  FetchStatus,
  SWRError,
  CacheEntry,
  HashedKey,
  ValidKey,
  ResolvedSWROptions,
} from "../types/index.ts";
import type { Observer } from "../cache/types.ts";
import { deriveStatus } from "./helpers.ts";
import { generateId } from "../utils/env.ts";

/** Store state bag passed to createObserver (useStore proxy object) */
export interface SWRState<Data> {
  data: Data | undefined;
  error: SWRError | undefined;
  status: Status;
  fetchStatus: FetchStatus;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isValidating: boolean;
  isStale: boolean;
}

/**
 * Create an Observer that bridges CacheStore notifications to Qwik useStore state.
 */
export function createObserver<Data>(
  hashedKey: HashedKey,
  rawKey: unknown,
  state: SWRState<Data>,
  resolved: ResolvedSWROptions<Data>,
): Observer<Data> {
  return {
    id: generateId("obs"),
    hashedKey,
    lastRawKey: rawKey as ValidKey,
    hasData: state.data != null,
    onData: (entry: CacheEntry<Data>) => {
      state.data = entry.data;
      state.error = undefined;
      const newStatus = deriveStatus(true, false, state.fetchStatus);
      state.status = newStatus;
      state.isSuccess = true;
      state.isError = false;
      state.isLoading = false;
      state.isStale =
        resolved.staleTime > 0 ? Date.now() - entry.timestamp > resolved.staleTime : true;
    },
    onError: (swrError: SWRError) => {
      state.error = swrError;
      const hasDataNow = state.data != null;
      const newStatus = deriveStatus(hasDataNow, true, state.fetchStatus);
      state.status = newStatus;
      state.isError = true;
      state.isLoading = false;
    },
    onFetchStatusChange: (fs: FetchStatus) => {
      state.fetchStatus = fs;
      state.isValidating = fs === "fetching";

      const hasDataNow = state.data != null;
      const hasErrorNow = state.error != null;
      const newStatus = deriveStatus(hasDataNow, hasErrorNow, fs);
      state.status = newStatus;
      state.isLoading = newStatus === "loading";
    },
  };
}
