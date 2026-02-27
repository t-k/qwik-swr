/** Timer group: one shared setInterval per interval duration */
interface TimerGroup {
  intervalMs: number;
  callbacks: Map<string, () => void>;
  timerId: ReturnType<typeof setInterval> | null;
}

/** Timer coordinator API */
export interface TimerCoordinatorApi {
  /**
   * Register a callback in a timer group for the given interval.
   * @returns unregister function
   */
  register(intervalMs: number, id: string, callback: () => void): () => void;
  /** Stop all timers and clear all groups (for tests) */
  _reset(): void;
  /** Active timer group count (for tests/debug) */
  _activeGroupCount(): number;
}

import { isDev } from "../utils/env.ts";

/** Upper bound on tracked timer groups to prevent unbounded Map growth */
const MAX_GROUPS = 64;

// Module-level state (singleton)
const groups = new Map<number, TimerGroup>();
// Standalone groups created when MAX_GROUPS is exceeded (not tracked in groups Map)
const standaloneGroups = new Set<TimerGroup>();

function ensureGroup(intervalMs: number): TimerGroup {
  let group = groups.get(intervalMs);
  if (group) return group;

  if (groups.size >= MAX_GROUPS) {
    if (isDev()) {
      console.warn(
        `[qwik-swr] timerCoordinator: MAX_GROUPS (${MAX_GROUPS}) reached. ` +
          `Interval ${intervalMs}ms will use a standalone timer.`,
      );
    }
    // Standalone group: tracked separately for cleanup
    const standalone: TimerGroup = { intervalMs, callbacks: new Map(), timerId: null };
    standaloneGroups.add(standalone);
    return standalone;
  }

  group = {
    intervalMs,
    callbacks: new Map(),
    timerId: null,
  };
  groups.set(intervalMs, group);
  return group;
}

function startTimer(group: TimerGroup): void {
  if (group.timerId !== null) return;
  group.timerId = setInterval(() => {
    for (const cb of group.callbacks.values()) {
      try {
        cb();
      } catch {
        /* swallow callback errors to protect other callbacks in group (SF-14) */
      }
    }
  }, group.intervalMs);
}

function stopTimer(group: TimerGroup): void {
  if (group.timerId !== null) {
    clearInterval(group.timerId);
    group.timerId = null;
  }
}

export const timerCoordinator: TimerCoordinatorApi = {
  register(intervalMs: number, id: string, callback: () => void): () => void {
    const group = ensureGroup(intervalMs);
    // Detect whether the group is standalone (not tracked in the global Map)
    const isStandalone = !groups.has(intervalMs);
    group.callbacks.set(id, callback);

    // Start timer if this is the first callback
    if (group.callbacks.size === 1) {
      startTimer(group);
    }

    // Return unregister function
    return () => {
      group.callbacks.delete(id);
      if (group.callbacks.size === 0) {
        stopTimer(group);
        if (isStandalone) {
          standaloneGroups.delete(group);
        } else {
          groups.delete(intervalMs);
        }
      }
    };
  },

  _reset(): void {
    for (const group of groups.values()) {
      stopTimer(group);
    }
    groups.clear();
    for (const group of standaloneGroups) {
      stopTimer(group);
    }
    standaloneGroups.clear();
  },

  _activeGroupCount(): number {
    return groups.size;
  },
};
