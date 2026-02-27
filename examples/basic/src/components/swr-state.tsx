import { component$ } from "@builder.io/qwik";
import type { Status, FetchStatus, SWRError } from "qwik-swr";

interface Props {
  data: unknown;
  error: SWRError | undefined;
  status: Status;
  fetchStatus: FetchStatus;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isValidating: boolean;
  isStale: boolean;
}

export const SWRStateInspector = component$<Props>((props) => {
  return (
    <details
      open
      style="margin-top: 24px; border: 1px solid #ddd; border-radius: 4px; padding: 12px;"
    >
      <summary style="cursor: pointer; font-weight: bold; font-size: 14px;">
        SWR State Inspector
      </summary>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; margin-top: 12px; font-size: 13px;">
        <div>
          <strong>status:</strong> <code>{props.status}</code>
        </div>
        <div>
          <strong>fetchStatus:</strong> <code>{props.fetchStatus}</code>
        </div>
        <div>
          <strong>isLoading:</strong> <code>{String(props.isLoading)}</code>
        </div>
        <div>
          <strong>isSuccess:</strong> <code>{String(props.isSuccess)}</code>
        </div>
        <div>
          <strong>isError:</strong> <code>{String(props.isError)}</code>
        </div>
        <div>
          <strong>isValidating:</strong> <code>{String(props.isValidating)}</code>
        </div>
        <div>
          <strong>isStale:</strong> <code>{String(props.isStale)}</code>
        </div>
        <div>
          <strong>hasData:</strong> <code>{String(props.data != null)}</code>
        </div>
        <div>
          <strong>hasError:</strong> <code>{String(props.error != null)}</code>
        </div>
      </div>
      {props.error && (
        <pre style="color: #c00; margin-top: 8px;">
          Error: {props.error.type} - {props.error.message} (retry: {props.error.retryCount})
        </pre>
      )}
      <details open style="margin-top: 8px;">
        <summary style="cursor: pointer; font-size: 12px; color: #666;">Raw data</summary>
        <pre style="max-height: 200px; overflow-y: auto; font-size: 12px;">
          {JSON.stringify(props.data, null, 2)}
        </pre>
      </details>
    </details>
  );
});
