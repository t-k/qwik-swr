import { component$, useSignal, useVisibleTask$, $ } from "@builder.io/qwik";
import { store } from "../src/cache/store.ts";
import { cache } from "../src/cache/cache-api.ts";
import type { DebugSnapshot, HashedKey } from "../src/types/index.ts";
import { isDev } from "../src/utils/env.ts";

interface SWRDevtoolsProps {
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  initialOpen?: boolean;
  /** Polling interval in milliseconds. Default: 2000. */
  pollingInterval?: number;
}

export const SWRDevtools = component$<SWRDevtoolsProps>((props) => {
  const isOpen = useSignal(props.initialOpen ?? false);
  const snapshot = useSignal<DebugSnapshot | null>(null);
  const flashMessage = useSignal<string | null>(null);

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    // Only enable polling in DEV mode
    if (!isDev()) {
      snapshot.value = store.getDebugSnapshot();
      return;
    }

    const pollingInterval = props.pollingInterval ?? 2000;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const update = () => {
      snapshot.value = store.getDebugSnapshot();
    };

    const startPolling = () => {
      if (intervalId === null) {
        update();
        intervalId = setInterval(update, pollingInterval);
      }
    };

    const stopPolling = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        startPolling();
      } else {
        stopPolling();
      }
    };

    // Initial update and start polling if tab is visible
    if (document.visibilityState === "visible") {
      startPolling();
    } else {
      update(); // Get initial snapshot even if hidden
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    cleanup(() => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    });
  });

  const handleRevalidate$ = $((hashedKey: HashedKey) => {
    const ok = store.revalidateByKey(hashedKey);
    if (!ok) {
      flashMessage.value = `No observers for "${hashedKey}" - revalidation skipped`;
      setTimeout(() => {
        flashMessage.value = null;
      }, 3000);
    }
    // Refresh snapshot immediately
    snapshot.value = store.getDebugSnapshot();
  });

  const handleDelete$ = $((hashedKey: HashedKey) => {
    store.deleteCache(hashedKey);
    snapshot.value = store.getDebugSnapshot();
  });

  const handleExport$ = $(() => {
    const data = cache.export();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `swr-cache-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const handleImport$ = $(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result as string);
          // Validate imported data schema (MF-14)
          if (
            !data ||
            typeof data !== "object" ||
            data.version !== 1 ||
            !Array.isArray(data.entries)
          ) {
            if (isDev()) {
              // eslint-disable-next-line no-console
              console.warn("[qwik-swr] Invalid cache export format");
            }
            return;
          }
          // Validate each entry has required fields
          const valid = data.entries.every(
            (e: any) =>
              e &&
              typeof e === "object" &&
              typeof e.hashedKey === "string" &&
              e.entry &&
              typeof e.entry === "object" &&
              typeof e.entry.timestamp === "number",
          );
          if (!valid) {
            if (isDev()) {
              // eslint-disable-next-line no-console
              console.warn("[qwik-swr] Invalid cache entries in import data");
            }
            return;
          }
          cache.import(data, { strategy: "merge" });
          snapshot.value = store.getDebugSnapshot();
        } catch {
          // ignore invalid JSON
        }
      };
      reader.readAsText(file);
    };
    input.click();
  });

  const position = props.position ?? "bottom-right";

  const positionStyles: Record<string, string> = {
    "bottom-right": "bottom: 0; right: 0;",
    "bottom-left": "bottom: 0; left: 0;",
    "top-right": "top: 0; right: 0;",
    "top-left": "top: 0; left: 0;",
  };

  const formatAge = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
    return `${Math.floor(ms / 3600000)}h`;
  };

  const statusColor = (status: string): string => {
    switch (status) {
      case "fresh":
        return "#0f0";
      case "stale":
        return "#ff0";
      case "fetching":
        return "#0af";
      case "error":
        return "#f00";
      default:
        return "#eee";
    }
  };

  const btnStyle =
    "padding: 1px 4px; cursor: pointer; background: #2a2a3e; color: #ccc; border: 1px solid #555; font-size: 10px;";

  return (
    <div
      style={`position: fixed; ${positionStyles[position]} z-index: 99999; font-family: monospace; font-size: 12px;`}
    >
      <button
        onClick$={() => {
          isOpen.value = !isOpen.value;
        }}
        style="padding: 4px 8px; background: #1a1a2e; color: #e94560; border: 1px solid #e94560; cursor: pointer;"
      >
        SWR {isOpen.value ? "[-]" : "[+]"}
      </button>
      {isOpen.value && snapshot.value && (
        <div style="background: #1a1a2e; color: #eee; border: 1px solid #333; max-height: 300px; overflow: auto; width: 560px; padding: 8px;">
          <div style="margin-bottom: 8px; color: #999; display: flex; justify-content: space-between; align-items: center;">
            <span>
              Entries: {snapshot.value.entries.length} | Observers: {snapshot.value.totalObservers}{" "}
              | Inflight: {snapshot.value.inflightCount}
            </span>
            <span>
              <button onClick$={handleExport$} style={btnStyle}>
                Export
              </button>{" "}
              <button onClick$={handleImport$} style={btnStyle}>
                Import
              </button>
            </span>
          </div>
          {flashMessage.value && (
            <div style="background: #4a3000; color: #ffa500; padding: 4px 8px; margin-bottom: 4px; font-size: 11px; border: 1px solid #665500;">
              {flashMessage.value}
            </div>
          )}
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="border-bottom: 1px solid #333;">
                <th style="text-align: left; padding: 2px 4px;">Key</th>
                <th style="text-align: left; padding: 2px 4px;">Status</th>
                <th style="text-align: right; padding: 2px 4px;">Age</th>
                <th style="text-align: right; padding: 2px 4px;">Obs</th>
                <th style="text-align: right; padding: 2px 4px;">Actions</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.value.entries.map((entry) => (
                <tr key={entry.hashedKey} style="border-bottom: 1px solid #222;">
                  <td
                    style="padding: 2px 4px;"
                    title={entry.rawKey ? String(entry.rawKey) : undefined}
                  >
                    {entry.hashedKey}
                  </td>
                  <td style={`padding: 2px 4px; color: ${statusColor(entry.status)};`}>
                    {entry.status}
                  </td>
                  <td style="padding: 2px 4px; text-align: right;">{formatAge(entry.age)}</td>
                  <td style="padding: 2px 4px; text-align: right;">{entry.observerCount}</td>
                  <td style="padding: 2px 4px; text-align: right; white-space: nowrap;">
                    <button onClick$={() => handleRevalidate$(entry.hashedKey)} style={btnStyle}>
                      Revalidate
                    </button>{" "}
                    <button onClick$={() => handleDelete$(entry.hashedKey)} style={btnStyle}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
});
