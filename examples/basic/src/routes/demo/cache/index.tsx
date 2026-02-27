import { component$, $, useSignal } from "@builder.io/qwik";
import { useSWR, cache } from "qwik-swr";
import { SWRDevtools } from "qwik-swr/devtools";
import type { Post, User } from "~/lib/mock-db";
import { SWRStateInspector } from "~/components/swr-state";
import { Tabs } from "~/components/tabs";
import { DemoPage } from "~/components/demo-page";
import { CodeBlock } from "~/components/code-block";

const TABS = [
  { id: "prefetch", label: "Prefetch" },
  { id: "export-import", label: "Export & Import" },
  { id: "devtools", label: "SWRDevtools" },
] as const;

const CORE_CODE = `import { cache } from "qwik-swr";

cache.prefetch(key, fetcher);          // pre-populate
const snapshot = cache.export();       // serialize
cache.import(snapshot, { strategy: "merge" }); // restore
cache.clear();                         // reset`;

// ── Tab 1: Prefetch ──

const PREFETCH_CODE = `cache.prefetch(\`/api/users/\${id}\`, async ({ signal }) => {
  const res = await fetch(\`/api/users/\${id}\`, { signal });
  return res.json();
});`;

const PrefetchUserDetail = component$<{ userId: number }>(({ userId }) => {
  const swr = useSWR<User>(
    `/api/users/${userId}`,
    $(async (ctx) => {
      const res = await fetch(`/api/users/${userId}`, { signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
  );

  return (
    <div style="border: 1px solid #ddd; border-radius: 6px; padding: 16px; margin-top: 16px;">
      <h3>User Detail (id: {userId})</h3>
      {swr.isLoading && <p>Loading...</p>}
      {swr.data && (
        <div>
          <p>
            <strong>Name:</strong> {swr.data.name}
          </p>
          <p>
            <strong>Email:</strong> {swr.data.email}
          </p>
          <p style="font-size: 12px; color: #999;">
            {swr.isStale ? "Loaded from prefetch cache" : "Fresh data"}
          </p>
        </div>
      )}
      <SWRStateInspector
        data={swr.data}
        error={swr.error}
        status={swr.status}
        fetchStatus={swr.fetchStatus}
        isLoading={swr.isLoading}
        isSuccess={swr.isSuccess}
        isError={swr.isError}
        isValidating={swr.isValidating}
        isStale={swr.isStale}
      />
    </div>
  );
});

const PrefetchTab = component$(() => {
  const selectedUser = useSignal<number | null>(null);
  const prefetchedIds = useSignal<number[]>([]);

  const userIds = [1, 2, 3, 4, 5];

  const handleHover = $((userId: number) => {
    if (prefetchedIds.value.includes(userId)) return;
    cache.prefetch(`/api/users/${userId}`, async ({ signal }) => {
      const res = await fetch(`/api/users/${userId}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
    prefetchedIds.value = [...prefetchedIds.value, userId];
  });

  return (
    <div>
      <h2>cache.prefetch Demo</h2>
      <p>
        Hover over a user card to prefetch their details with <code>cache.prefetch</code>. Click to
        view -- the data loads instantly from the prefetch cache.
      </p>

      <CodeBlock code={PREFETCH_CODE} />

      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; margin: 16px 0;">
        {userIds.map((id) => (
          <button
            key={id}
            onMouseEnter$={() => handleHover(id)}
            onClick$={() => {
              selectedUser.value = id;
            }}
            style={{
              padding: "12px",
              border: selectedUser.value === id ? "2px solid #0066cc" : "1px solid #ddd",
              borderRadius: "6px",
              background: prefetchedIds.value.includes(id) ? "#f0f8ff" : "#fff",
              cursor: "pointer",
              textAlign: "left" as const,
            }}
          >
            <strong>User {id}</strong>
            <br />
            <span style="font-size: 11px; color: #999;">
              {prefetchedIds.value.includes(id) ? "prefetched" : "hover to prefetch"}
            </span>
          </button>
        ))}
      </div>

      {selectedUser.value && (
        <PrefetchUserDetail key={selectedUser.value} userId={selectedUser.value} />
      )}
    </div>
  );
});

// ── Tab 2: Export & Import ──

const ExportImportTab = component$(() => {
  const posts = useSWR<Post[]>(
    "/api/posts",
    $(async (ctx) => {
      const res = await fetch("/api/posts", { signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
  );

  const users = useSWR<{ data: User[]; total: number }>(
    "/api/users?page=1",
    $(async (ctx) => {
      const res = await fetch("/api/users?page=1", { signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
    { freshness: "slow" },
  );

  const handleExport = $(() => {
    const data = cache.export();
    const json = JSON.stringify(data, null, 2);
    console.log("Exported cache:", json);
    alert(`Exported ${data.entries.length} entries. Check console for details.`);
  });

  const handleImportMerge = $(() => {
    const data = cache.export();
    cache.import(data, { strategy: "merge" });
    alert("Re-imported cache with merge strategy.");
  });

  return (
    <div>
      <h2>Export & Import</h2>
      <p>
        Use <code>cache.export()</code> to serialize, <code>cache.import()</code> to restore, and{" "}
        <code>cache.clear()</code> to reset.
      </p>

      <div style="display: flex; gap: 8px; margin: 16px 0;">
        <button onClick$={handleExport}>cache.export()</button>
        <button onClick$={handleImportMerge}>cache.import (merge)</button>
        <button
          onClick$={() => {
            cache.clear();
            alert("Cache cleared.");
          }}
        >
          cache.clear()
        </button>
      </div>

      <h3>Active SWR Hooks</h3>
      <div style="display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));">
        <div style="border: 1px solid #ddd; border-radius: 6px; padding: 12px;">
          <strong>/api/posts</strong> (freshness: normal)
          <p style="font-size: 13px; color: #666;">
            {posts.isLoading ? "Loading..." : posts.data ? `${posts.data.length} posts` : "No data"}
          </p>
        </div>
        <div style="border: 1px solid #ddd; border-radius: 6px; padding: 12px;">
          <strong>/api/users?page=1</strong> (freshness: slow)
          <p style="font-size: 13px; color: #666;">
            {users.isLoading
              ? "Loading..."
              : users.data
                ? `${users.data.data.length} users`
                : "No data"}
          </p>
        </div>
      </div>
    </div>
  );
});

// ── Tab 3: SWRDevtools ──

const DevtoolsTab = component$(() => {
  const slow = useSWR<{ message: string }>(
    "/api/test?type=slow",
    $(async (ctx) => {
      const res = await fetch("/api/test?type=slow", { signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
    { freshness: "volatile" },
  );

  return (
    <div>
      <h2>SWRDevtools</h2>
      <p>
        The <code>{"<SWRDevtools />"}</code> panel (bottom-right corner) shows all cache entries
        with their status, age, and observer count. You can Revalidate, Delete entries, and
        Export/Import cache snapshots.
      </p>

      <CodeBlock
        code={`import { SWRDevtools } from "qwik-swr/devtools";
<SWRDevtools position="bottom-right" />`}
      />

      <div style="border: 1px solid #ddd; border-radius: 6px; padding: 12px; margin: 16px 0;">
        <strong>/api/test?type=slow</strong> (freshness: volatile)
        <p style="font-size: 13px; color: #666;">
          {slow.isLoading ? "Loading..." : slow.data ? slow.data.message : "No data"}
        </p>
      </div>

      <SWRDevtools position="bottom-right" initialOpen={true} />
    </div>
  );
});

// ── Page ──

export default component$(() => {
  return (
    <DemoPage
      title="cache API"
      description="Prefetch, export/import, and SWRDevtools for cache inspection."
    >
      <CodeBlock q:slot="code" code={CORE_CODE} />

      <Tabs tabs={[...TABS]}>
        <PrefetchTab q:slot="prefetch" />
        <ExportImportTab q:slot="export-import" />
        <DevtoolsTab q:slot="devtools" />
      </Tabs>
    </DemoPage>
  );
});
