import { component$, $ } from "@builder.io/qwik";
import { useSWR, FRESHNESS_PRESETS } from "qwik-swr";
import { SWRStateInspector } from "~/components/swr-state";
import { DemoPage } from "~/components/demo-page";
import { CodeBlock } from "~/components/code-block";

interface SlowResponse {
  message: string;
  timestamp: number;
}

const fetcher$ = $(async (ctx: { signal: AbortSignal; rawKey: string }) => {
  const res = await fetch("/api/test?type=slow", { signal: ctx.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SlowResponse>;
});

const CORE_CODE = `import { FRESHNESS_PRESETS } from "qwik-swr";

// volatile: staleTime=0, cacheTime=0
useSWR("key:volatile", fetcher$, { freshness: "volatile" });

// normal: staleTime=30s, cacheTime=5min
useSWR("key:normal",   fetcher$, { freshness: "normal" });

// static: staleTime=MAX, cacheTime=MAX
useSWR("key:static",   fetcher$, { freshness: "static" });`;

export default component$(() => {
  // Each needs a unique key to avoid QueryConfig fixation
  const volatile = useSWR<SlowResponse>("freshness:volatile", fetcher$, {
    freshness: "volatile",
  });
  const normal = useSWR<SlowResponse>("freshness:normal", fetcher$, {
    freshness: "normal",
  });
  const staticR = useSWR<SlowResponse>("freshness:static", fetcher$, {
    freshness: "static",
  });

  return (
    <DemoPage
      title="FRESHNESS_PRESETS"
      description="Compare volatile, normal, and static presets with a 2-second slow endpoint."
    >
      <CodeBlock q:slot="code" code={CORE_CODE} />

      <h3>Preset Values</h3>
      <table style="border-collapse: collapse; width: 100%; font-size: 13px; margin-bottom: 20px;">
        <thead>
          <tr style="border-bottom: 2px solid #ddd;">
            <th style="text-align: left; padding: 6px;">Preset</th>
            <th style="text-align: right; padding: 6px;">staleTime</th>
            <th style="text-align: right; padding: 6px;">cacheTime</th>
            <th style="text-align: right; padding: 6px;">dedupingInterval</th>
          </tr>
        </thead>
        <tbody>
          {(["volatile", "normal", "static"] as const).map((name) => {
            const p = FRESHNESS_PRESETS[name];
            const fmt = (n: number) => (n >= Number.MAX_SAFE_INTEGER ? "MAX" : `${n / 1000}s`);
            return (
              <tr key={name} style="border-bottom: 1px solid #eee;">
                <td style="padding: 6px;">
                  <code>{name}</code>
                </td>
                <td style="text-align: right; padding: 6px;">{fmt(p.staleTime)}</td>
                <td style="text-align: right; padding: 6px;">{fmt(p.cacheTime)}</td>
                <td style="text-align: right; padding: 6px;">{fmt(p.dedupingInterval)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;">
        {[
          { label: "volatile", swr: volatile },
          { label: "normal", swr: normal },
          { label: "static", swr: staticR },
        ].map((item) => (
          <div key={item.label} style="border: 1px solid #ddd; border-radius: 6px; padding: 12px;">
            <h3 style="margin-top: 0;">{item.label}</h3>
            {item.swr.isLoading && <p>Loading...</p>}
            {item.swr.data && (
              <div style="font-size: 13px;">
                <p>Fetched: {new Date(item.swr.data.timestamp).toLocaleTimeString()}</p>
                <p>
                  isStale: <code>{String(item.swr.isStale)}</code>
                </p>
                <p>
                  status: <code>{item.swr.status}</code>
                </p>
              </div>
            )}
            <button onClick$={() => item.swr.revalidate$()}>Revalidate</button>
          </div>
        ))}
      </div>

      <h3 style="margin-top: 24px;">volatile - Full Inspector</h3>
      <SWRStateInspector
        data={volatile.data}
        error={volatile.error}
        status={volatile.status}
        fetchStatus={volatile.fetchStatus}
        isLoading={volatile.isLoading}
        isSuccess={volatile.isSuccess}
        isError={volatile.isError}
        isValidating={volatile.isValidating}
        isStale={volatile.isStale}
      />
    </DemoPage>
  );
});
