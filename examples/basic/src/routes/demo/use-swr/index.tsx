import { component$, $, useSignal, useVisibleTask$ } from "@builder.io/qwik";
import { routeLoader$ } from "@builder.io/qwik-city";
import { useSWR, _getSubscriberCounts } from "qwik-swr";
import type { Post, User } from "~/lib/mock-db";
import { SWRStateInspector } from "~/components/swr-state";
import { Tabs } from "~/components/tabs";
import { DemoPage } from "~/components/demo-page";
import { CodeBlock } from "~/components/code-block";

// SSR tab: server-side data loading via routeLoader$
export const usePostsLoader = routeLoader$(async () => {
  const { getPosts } = await import("~/lib/mock-db");
  return getPosts();
});

const TABS = [
  { id: "basic", label: "Basic Fetch" },
  { id: "pagination", label: "Pagination" },
  { id: "conditional", label: "Conditional" },
  { id: "mutate", label: "Mutate & Revalidate" },
  { id: "ssr", label: "SSR Integration" },
  { id: "error", label: "Error & Retry" },
  { id: "focus", label: "Focus & Reconnect" },
] as const;

const CORE_CODE = `const { data, error, isLoading, mutate$, revalidate$ } = useSWR(
  "/api/posts",
  $((ctx) => fetch(ctx.rawKey, { signal: ctx.signal }).then(r => r.json())),
);`;

// ── Tab 1: Basic Fetch ──

const BasicFetchTab = component$(() => {
  const swr = useSWR<Post[]>(
    "/api/posts",
    $(async (ctx) => {
      const res = await fetch("/api/posts", { signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
  );

  return (
    <div>
      <h2>Basic Data Fetching</h2>
      <p>
        The simplest <code>useSWR</code> usage: a string key and a fetcher function.
      </p>

      <CodeBlock code={`useSWR("/api/posts", $(async (ctx) => { ... }))`} />

      {swr.isLoading && <p>Loading...</p>}

      {swr.isSuccess && swr.data && (
        <ul>
          {swr.data.map((post) => (
            <li key={post.id}>
              <strong>{post.title}</strong> - {post.body}
            </li>
          ))}
        </ul>
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

// ── Tab 2: Pagination ──

interface UsersResponse {
  data: Array<{ id: number; name: string; email: string }>;
  total: number;
  page: number;
  totalPages: number;
}

const PageContent = component$<{ page: number; totalPages: number }>((props) => {
  const swr = useSWR<UsersResponse>(
    ["users", props.page] as const,
    $(async (ctx) => {
      const [, p] = ctx.rawKey;
      const res = await fetch(`/api/users?page=${p}`, { signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
  );

  return (
    <div>
      {swr.isLoading && <p>Loading...</p>}

      {swr.data && (
        <table style="width: 100%; border-collapse: collapse; margin: 12px 0;">
          <thead>
            <tr style="border-bottom: 2px solid #ddd;">
              <th style="text-align: left; padding: 8px;">ID</th>
              <th style="text-align: left; padding: 8px;">Name</th>
              <th style="text-align: left; padding: 8px;">Email</th>
            </tr>
          </thead>
          <tbody>
            {swr.data.data.map((user) => (
              <tr key={user.id} style="border-bottom: 1px solid #eee;">
                <td style="padding: 8px;">{user.id}</td>
                <td style="padding: 8px;">{user.name}</td>
                <td style="padding: 8px;">{user.email}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {swr.isValidating && <span style="color: #999; font-size: 13px;">Revalidating...</span>}

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

const PaginationTab = component$(() => {
  const page = useSignal(1);
  const totalPages = 4;

  return (
    <div>
      <h2>Array Key Pagination</h2>
      <p>
        Use array key <code>["users", page]</code> to re-fetch when page changes. The page content
        component remounts on page change via <code>key</code> prop.
      </p>

      <CodeBlock code={`useSWR(["users", page] as const, fetcher$)`} />

      <p>
        Current key: <code>{JSON.stringify(["users", page.value])}</code>
      </p>

      <div style="display: flex; gap: 12px; align-items: center; margin: 16px 0;">
        <button
          disabled={page.value <= 1}
          onClick$={() => {
            page.value--;
          }}
        >
          Prev
        </button>
        <span>
          Page {page.value} / {totalPages}
        </span>
        <button
          disabled={page.value >= totalPages}
          onClick$={() => {
            page.value++;
          }}
        >
          Next
        </button>
      </div>

      <PageContent key={page.value} page={page.value} totalPages={totalPages} />
    </div>
  );
});

// ── Tab 3: Conditional ──

const UserDetail = component$<{ userId: number }>((props) => {
  const swr = useSWR<User>(
    `/api/users/${props.userId}`,
    $(async (ctx) => {
      const res = await fetch(ctx.rawKey as string, { signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
  );

  return (
    <div>
      {swr.isLoading && <p>Loading...</p>}

      {swr.data && (
        <div style="border: 1px solid #ddd; border-radius: 6px; padding: 16px;">
          <p>
            <strong>ID:</strong> {swr.data.id}
          </p>
          <p>
            <strong>Name:</strong> {swr.data.name}
          </p>
          <p>
            <strong>Email:</strong> {swr.data.email}
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

const ConditionalTab = component$(() => {
  const userId = useSignal<number | null>(null);

  return (
    <div>
      <h2>Conditional Fetching</h2>
      <p>
        Pass <code>null</code> as key to disable fetching. Select a user ID to start. The detail
        component mounts/unmounts based on selection.
      </p>

      <CodeBlock code={`useSWR(userId ? \`/api/users/\${userId}\` : null, fetcher$)`} />

      <div style="display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap;">
        <button
          style={{ background: userId.value === null ? "#e0e7ff" : "" }}
          onClick$={() => {
            userId.value = null;
          }}
        >
          None (null key)
        </button>
        {[1, 2, 3, 5, 10].map((id) => (
          <button
            key={id}
            style={{ background: userId.value === id ? "#e0e7ff" : "" }}
            onClick$={() => {
              userId.value = id;
            }}
          >
            User {id}
          </button>
        ))}
      </div>

      <p>
        Key: <code>{userId.value ? `/api/users/${userId.value}` : "null"}</code>
      </p>

      {userId.value === null && (
        <p style="color: #999;">No user selected. Component not mounted.</p>
      )}

      {userId.value !== null && <UserDetail key={userId.value} userId={userId.value} />}
    </div>
  );
});

// ── Tab 4: Mutate & Revalidate ──

const MutateTab = component$(() => {
  const nextId = useSignal(100);

  const swr = useSWR<Post[]>(
    "/api/posts",
    $(async (ctx) => {
      const res = await fetch("/api/posts", { signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
  );

  const handleOptimisticAdd = $(() => {
    const id = nextId.value++;
    swr.mutate$((current) => [
      ...(current ?? []),
      { id, title: `New Post #${id}`, body: "Optimistically added" },
    ]);
  });

  const handleMutateNoRevalidate = $(() => {
    const id = nextId.value++;
    swr.mutate$(
      (current) => [
        ...(current ?? []),
        { id, title: `Local Only #${id}`, body: "No server revalidation" },
      ],
      { revalidate: false },
    );
  });

  const handleRevalidate = $(() => {
    swr.revalidate$();
  });

  return (
    <div>
      <h2>Mutate & Revalidate</h2>
      <p>
        <code>mutate$</code> for optimistic updates, <code>revalidate$</code> for force refetch.
      </p>

      <div style="display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap;">
        <button onClick$={handleOptimisticAdd}>mutate$ (+ revalidate)</button>
        <button onClick$={handleMutateNoRevalidate}>mutate$ (no revalidate)</button>
        <button onClick$={handleRevalidate}>revalidate$</button>
      </div>

      {swr.isLoading && <p>Loading...</p>}

      {swr.data && (
        <ul>
          {swr.data.map((post) => (
            <li key={post.id} style={{ color: post.id >= 100 ? "#07a" : "inherit" }}>
              <strong>{post.title}</strong> - {post.body}
              {post.id >= 100 && <span style="font-size: 12px; color: #999;"> (local)</span>}
            </li>
          ))}
        </ul>
      )}

      {swr.isValidating && <p style="color: #999; font-size: 13px;">Background revalidating...</p>}

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

// ── Tab 5: SSR Integration ──

const SSR_CODE = `export const usePostsLoader = routeLoader$(async () => {
  const { getPosts } = await import("~/lib/mock-db");
  return getPosts();
});

// In component:
const loader = usePostsLoader();
const swr = useSWR("/api/posts", fetcher$, {
  fallbackData: loader.value,
});`;

const SSRTab = component$<{ fallbackData: Post[] }>(({ fallbackData }) => {
  const swr = useSWR<Post[]>(
    "/api/posts",
    $(async (ctx) => {
      const res = await fetch("/api/posts", { signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
    {
      fallbackData,
    },
  );

  return (
    <div>
      <h2>SSR Integration</h2>
      <p>
        Data is pre-loaded with <code>routeLoader$</code> and passed as <code>fallbackData</code>.
        No loading spinner on initial render.
      </p>

      <CodeBlock code={SSR_CODE} />

      <div style="border: 1px solid #d4edda; background: #f0fdf4; border-radius: 6px; padding: 12px; margin: 16px 0; font-size: 13px;">
        <strong>Note:</strong> This page has data immediately on first render (SSR). The client will
        revalidate in the background if the data is stale.
      </div>

      {swr.data && (
        <ul>
          {swr.data.map((post) => (
            <li key={post.id}>
              <strong>{post.title}</strong> - {post.body}
            </li>
          ))}
        </ul>
      )}

      {swr.isValidating && <p style="color: #999; font-size: 13px;">Background revalidating...</p>}

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

// ── Tab 6: Error & Retry ──

const ERROR_CODE = `useSWR("/api/test?type=error", fetcher$, {
  retry: 3,
  retryInterval: 1000, // exponential backoff
  onError$: $((err) => {
    console.log(err.type, err.message, err.retryCount);
  }),
});`;

const ErrorRetryTab = component$(() => {
  const errorLog = useSignal<string[]>([]);

  const swr = useSWR<{ message: string }>(
    "/api/test?type=error",
    $(async (ctx) => {
      const res = await fetch("/api/test?type=error", { signal: ctx.signal });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    }),
    {
      retry: 3,
      retryInterval: 1000,
      onError$: $((err: { type: string; message: string; retryCount: number }) => {
        errorLog.value = [
          ...errorLog.value,
          `[${new Date().toLocaleTimeString()}] ${err.type}: ${err.message} (retryCount: ${err.retryCount})`,
        ];
      }),
    },
  );

  return (
    <div>
      <h2>Error Handling & Retry</h2>
      <p>
        Endpoint <code>/api/test?type=error</code> always returns 500. With <code>retry: 3</code>{" "}
        and <code>retryInterval: 1000</code> (exponential backoff).
      </p>

      <CodeBlock code={ERROR_CODE} />

      {swr.isLoading && <p>Loading (with retries)...</p>}

      {swr.isError && swr.error && (
        <div style="border: 1px solid #f5c6cb; background: #fdf0f0; border-radius: 6px; padding: 16px; margin: 12px 0;">
          <p style="margin: 0; color: #c00;">
            <strong>Error:</strong> {swr.error.message}
          </p>
          <p style="margin: 4px 0 0; font-size: 13px; color: #666;">
            Type: {swr.error.type} | Retry count: {swr.error.retryCount}
          </p>
        </div>
      )}

      {swr.data && (
        <div style="border: 1px solid #b7e4c7; background: #f0fdf4; border-radius: 6px; padding: 16px;">
          <p style="color: #080;">Success: {swr.data.message}</p>
        </div>
      )}

      {errorLog.value.length > 0 && (
        <div style="margin-top: 16px;">
          <h3>Error Log (onError$ callback)</h3>
          <div style="background: #1a1a2e; color: #aab; border-radius: 6px; padding: 12px; font-size: 12px; font-family: monospace; max-height: 200px; overflow-y: auto;">
            {errorLog.value.map((log, i) => (
              <div key={i}>{log}</div>
            ))}
          </div>
          <button
            style="margin-top: 8px;"
            onClick$={() => {
              errorLog.value = [];
            }}
          >
            Clear log
          </button>
        </div>
      )}

      <div style="margin-top: 16px;">
        <button onClick$={() => swr.revalidate$()}>Retry now (revalidate$)</button>
      </div>

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

// ── Tab 7: Focus & Reconnect ──

const SHARED_KEY = "/api/test?type=time";

interface TimeResponse {
  timestamp: number;
  fetchCount: number;
}

const FOCUS_CODE = `// 5 hooks, same key -> 1 HTTP request (deduplication)
useSWR("/api/data", fetcher$, {
  staleTime: 0,
  revalidateOn: ["focus", "reconnect"],
});
// Global listener: 1 DOM listener shared by all hooks
// Deduplication: ensureFetch joins existing in-flight request`;

const DataCard = component$<{ cardId: number }>(({ cardId }) => {
  const swr = useSWR<TimeResponse>(
    SHARED_KEY,
    $(async (ctx) => {
      const res = await fetch(SHARED_KEY, { signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
    {
      staleTime: 0,
      revalidateOn: ["focus", "reconnect"],
    },
  );

  return (
    <div
      style={{
        border: "1px solid #444",
        borderRadius: "8px",
        padding: "16px",
        background: "#2a2a3e",
        minWidth: "160px",
        flex: "1",
      }}
    >
      <h3 style={{ margin: "0 0 8px 0", color: "#5bf" }}>Hook #{cardId}</h3>
      <p style={{ margin: "2px 0", fontSize: "11px", color: "#666" }}>
        key: <code>{SHARED_KEY}</code>
      </p>
      {swr.isLoading && <p style={{ color: "#888" }}>Loading...</p>}
      {swr.isSuccess && swr.data && (
        <>
          <p style={{ margin: "4px 0", fontSize: "12px", color: "#aaa" }}>
            Server fetch count: <strong style={{ color: "#5f5" }}>{swr.data.fetchCount}</strong>
          </p>
          <p style={{ margin: "4px 0", fontSize: "12px", color: "#aaa" }}>
            Time: {new Date(swr.data.timestamp).toLocaleTimeString()}
          </p>
        </>
      )}
      {swr.isValidating && (
        <p style={{ margin: "4px 0", fontSize: "11px", color: "#fa5" }}>Revalidating...</p>
      )}
    </div>
  );
});

const FocusReconnectTab = component$(() => {
  const subscriberCounts = useSignal({ focus: 0, reconnect: 0 });
  const focusCount = useSignal(0);

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    const update = () => {
      subscriberCounts.value = _getSubscriberCounts();
    };

    let count = 0;
    const handleFocus = () => {
      count++;
      focusCount.value = count;
    };

    update();
    const intervalId = setInterval(update, 500);
    window.addEventListener("focus", handleFocus);

    cleanup(() => {
      clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
    });
  });

  return (
    <div>
      <h2>Focus & Reconnect Revalidation</h2>
      <p>
        5 independent <code>useSWR</code> hooks sharing the same key (<code>{SHARED_KEY}</code>).
      </p>

      <CodeBlock code={FOCUS_CODE} />

      <div
        style={{
          background: "#1a1a2e",
          padding: "16px",
          borderRadius: "8px",
          marginBottom: "24px",
        }}
      >
        <h3 style={{ margin: "0 0 12px 0", color: "#fff" }}>Stats</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 32px" }}>
          <p style={{ margin: "4px 0", fontSize: "14px", color: "#ccc" }}>
            Focus subscribers:{" "}
            <strong style={{ color: "#5bf" }}>{subscriberCounts.value.focus}</strong>
          </p>
          <p style={{ margin: "4px 0", fontSize: "14px", color: "#888" }}>
            DOM listeners: <strong style={{ color: "#5f5" }}>1</strong> (not 5)
          </p>
          <p style={{ margin: "4px 0", fontSize: "14px", color: "#ccc" }}>
            Reconnect subscribers:{" "}
            <strong style={{ color: "#5bf" }}>{subscriberCounts.value.reconnect}</strong>
          </p>
          <p style={{ margin: "4px 0", fontSize: "14px", color: "#888" }}>
            DOM listeners: <strong style={{ color: "#5f5" }}>1</strong> (not 5)
          </p>
          <p style={{ margin: "4px 0", fontSize: "14px", color: "#ccc" }}>
            Focus events: <strong style={{ color: "#5f5" }}>{focusCount.value}</strong>
          </p>
          <p style={{ margin: "4px 0", fontSize: "14px", color: "#888" }}>
            (switch tab and back to trigger)
          </p>
        </div>
      </div>

      <div
        style={{
          background: "#1e2a1e",
          border: "1px solid #3a5a3a",
          padding: "16px",
          borderRadius: "8px",
          marginBottom: "24px",
        }}
      >
        <h3 style={{ margin: "0 0 8px 0", color: "#8f8" }}>Deduplication</h3>
        <p style={{ margin: "0", fontSize: "14px", color: "#ccc" }}>
          All 5 hooks use the same key. On focus, the global listener notifies all 5 subscribers,
          but <strong>only 1 HTTP request</strong> is made (deduplication). Check "Server fetch
          count" below -- all cards show the same number.
        </p>
      </div>

      <h3>5 Hooks, Same Key, 1 Fetch</h3>

      <div
        style={{
          display: "flex",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        {[1, 2, 3, 4, 5].map((id) => (
          <DataCard key={id} cardId={id} />
        ))}
      </div>

      <div style={{ marginTop: "24px", padding: "16px", background: "#111", borderRadius: "8px" }}>
        <h3 style={{ margin: "0 0 8px 0" }}>How to verify:</h3>
        <ol style={{ margin: "0", paddingLeft: "20px", fontSize: "14px", color: "#ccc" }}>
          <li>Note the "Server fetch count" on each card (all 5 should show the same number)</li>
          <li>Switch to another tab, then switch back</li>
          <li>All 5 cards update simultaneously with the same new fetch count</li>
          <li>The count increments by 1, not by 5 -- proving only 1 HTTP request was made</li>
          <li>Open DevTools Network tab to confirm: 1 request per focus event</li>
        </ol>
      </div>
    </div>
  );
});

// ── Page ──

export default component$(() => {
  const loader = usePostsLoader();

  return (
    <DemoPage
      title="useSWR"
      description="Data fetching with caching, deduplication, revalidation, and SSR integration."
    >
      <CodeBlock q:slot="code" code={CORE_CODE} />

      <Tabs tabs={[...TABS]}>
        <BasicFetchTab q:slot="basic" />
        <PaginationTab q:slot="pagination" />
        <ConditionalTab q:slot="conditional" />
        <MutateTab q:slot="mutate" />
        <SSRTab q:slot="ssr" fallbackData={loader.value} />
        <ErrorRetryTab q:slot="error" />
        <FocusReconnectTab q:slot="focus" />
      </Tabs>
    </DemoPage>
  );
});
