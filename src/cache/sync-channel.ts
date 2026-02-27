import type { SyncMessage, SyncMessageType } from "../types/index.ts";
import { generateId, isDev } from "../utils/env.ts";

/** Sync channel API returned by createSyncChannel */
export interface SyncChannelApi {
  /** Broadcast message to all tabs */
  broadcast(msg: SyncMessage): void;
  /** Close channel and release resources */
  close(): void;
  /** This tab's unique identifier */
  tabId: string;
}

/**
 * Create a cross-tab sync channel using BroadcastChannel.
 *
 * Returns null if BroadcastChannel is unavailable (graceful degradation, FR-005).
 */
export function createSyncChannel(
  channelName: string,
  onMessage: (msg: SyncMessage) => void,
): SyncChannelApi | null {
  if (typeof BroadcastChannel === "undefined") {
    return null;
  }

  const tabId = generateId();

  let bc: BroadcastChannel | null;
  try {
    bc = new BroadcastChannel(channelName);
  } catch {
    // BroadcastChannel constructor can throw in some environments (e.g. opaque origins)
    return null;
  }

  // Known message types for validation (SF-19)
  // satisfies ensures every literal matches SyncMessageType at compile time
  const KNOWN_TYPES = new Set<string>([
    "set",
    "delete",
    "clear",
    "fetch-start",
    "fetch-complete",
    "fetch-error",
    "sub-data",
    "sub-status",
    "sub-error",
    "sub-leader-claim",
    "sub-leader-heartbeat",
    "sub-leader-resign",
  ] satisfies SyncMessageType[]);

  bc.onmessage = (event: MessageEvent) => {
    const data = event.data as SyncMessage | undefined;
    if (!data || typeof data !== "object") return;

    // Version check: only handle known versions (forward compatibility)
    if (data.version !== 1) return;

    // Type validation: only handle known message types (SF-19)
    if (typeof data.type !== "string" || !KNOWN_TYPES.has(data.type)) return;

    // Echo filtering: ignore own messages
    if (data.tabId === tabId) return;

    // Key validation: non-clear messages must have a string key (SF-5)
    if (data.type !== "clear" && typeof data.key !== "string") return;

    onMessage(data);
  };

  return {
    tabId,

    broadcast(msg: SyncMessage): void {
      if (!bc) return;
      try {
        bc.postMessage(msg);
      } catch (e) {
        // Structured Clone can fail for non-serializable data
        if (isDev()) {
          // eslint-disable-next-line no-console
          console.warn("[qwik-swr] Failed to broadcast sync message:", e);
        }
      }
    },

    close(): void {
      if (bc) {
        bc.onmessage = null;
        bc.close();
        bc = null;
      }
    },
  };
}
