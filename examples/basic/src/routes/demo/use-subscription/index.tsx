import { component$, $, useSignal, useStore, useVisibleTask$ } from "@builder.io/qwik";
import { routeLoader$ } from "@builder.io/qwik-city";
import { useSWR } from "qwik-swr";
import type { SubscriptionStatus } from "qwik-swr";
import { useSubscription, subscriptionRegistry } from "qwik-swr/subscription";
import type { Message } from "~/lib/mock-db";
import { SWRStateInspector } from "~/components/swr-state";
import { Tabs } from "~/components/tabs";
import { DemoPage } from "~/components/demo-page";
import { CodeBlock } from "~/components/code-block";

// SSR+SWR+Subscription tab: server-side data loading via routeLoader$
export const useMessagesLoader = routeLoader$(async () => {
  const { getMessages } = await import("~/lib/mock-db");
  return getMessages();
});

const TABS = [
  { id: "subscription", label: "Basic" },
  { id: "dedup", label: "Connection Dedup" },
  { id: "swr-sub", label: "SSR+SWR+Subscription" },
] as const;

const CORE_CODE = `const { data, status, unsubscribe$, reconnect$ } = useSubscription(
  "ticker",
  $((key, { onData, onError }) => {
    const ws = new WebSocket(\`wss://api/\${key}\`);
    ws.onmessage = (e) => onData(JSON.parse(e.data));
    ws.onerror = () => onError(new Error("connection lost"));
    return { unsubscribe: () => ws.close() };
  }),
  { maxRetries: 5, retryInterval: 1000 },
);`;

// ── Tab 1: Subscription ──

interface TickMessage {
  id: number;
  text: string;
  timestamp: number;
}

const SUBSCRIPTION_CODE = `useSubscription("ticker", $((key, { onData, onError }) => {
  const ws = new WebSocket(\`wss://api/\${key}\`);
  ws.onmessage = (e) => onData(JSON.parse(e.data));
  ws.onerror = () => onError(new Error("connection lost"));
  return { unsubscribe: () => ws.close() };
}), { maxRetries: 5 })`;

const SubscriptionTab = component$(() => {
  const log = useSignal<string[]>([]);

  const sub = useSubscription<TickMessage[]>(
    "ticker",
    $((key, { onData }) => {
      let count = 0;
      const messages: TickMessage[] = [];

      const timer = setInterval(() => {
        count++;
        const msg: TickMessage = {
          id: count,
          text: `Tick #${count} from "${key}"`,
          timestamp: Date.now(),
        };
        messages.push(msg);
        if (messages.length > 10) messages.shift();
        onData([...messages]);
      }, 1500);

      return {
        unsubscribe: () => {
          clearInterval(timer);
        },
      };
    }),
    {
      maxRetries: 5,
      retryInterval: 1000,
      onData$: $((_data: TickMessage[]) => {
        // Could inject into SWR cache via mutate$
      }),
      onStatusChange$: $((status: SubscriptionStatus) => {
        log.value = [
          ...log.value.slice(-19),
          `[${new Date().toLocaleTimeString()}] Status: ${status}`,
        ];
      }),
    },
  );

  const statusColor = (s: string) => {
    switch (s) {
      case "live":
        return "#0a0";
      case "connecting":
        return "#fa0";
      case "disconnected":
        return "#c00";
      default:
        return "#666";
    }
  };

  return (
    <div>
      <h2>useSubscription Demo</h2>
      <p>
        Real-time data subscription with automatic reconnection (exponential backoff), manual{" "}
        <code>unsubscribe$</code> / <code>reconnect$</code>, and status tracking.
      </p>

      <CodeBlock code={SUBSCRIPTION_CODE} />

      <div style="display: flex; gap: 12px; margin: 16px 0; align-items: center;">
        <span>
          Status: <strong style={`color: ${statusColor(sub.status)}`}>{sub.status}</strong>
        </span>
        <span>
          isLive: <code>{String(sub.isLive)}</code>
        </span>
        <span>
          isConnecting: <code>{String(sub.isConnecting)}</code>
        </span>
        <span>
          isDisconnected: <code>{String(sub.isDisconnected)}</code>
        </span>
      </div>

      <div style="display: flex; gap: 8px; margin: 8px 0;">
        <button onClick$={() => sub.unsubscribe$()}>unsubscribe$</button>
        <button onClick$={() => sub.reconnect$()}>reconnect$</button>
      </div>

      {sub.error && (
        <p style="color: #c00; font-size: 13px;">
          Error: {sub.error.message} (retry: {sub.error.retryCount})
        </p>
      )}

      <h3>Messages</h3>
      {sub.data && sub.data.length > 0 ? (
        <ul style="font-size: 13px; font-family: monospace;">
          {sub.data.map((msg) => (
            <li key={msg.id}>
              {msg.text}{" "}
              <span style="color: #999;">({new Date(msg.timestamp).toLocaleTimeString()})</span>
            </li>
          ))}
        </ul>
      ) : (
        <p style="color: #999;">Waiting for messages...</p>
      )}

      <details style="margin-top: 16px;">
        <summary style="cursor: pointer; font-size: 13px;">Event Log</summary>
        <pre style="font-size: 11px; max-height: 150px; overflow-y: auto;">
          {log.value.join("\n") || "(empty)"}
        </pre>
      </details>
    </div>
  );
});

// ── Tab 2: Connection Dedup ──

const SHARED_KEY = "shared-ticker";
const HASHED_KEY = `s:${SHARED_KEY}`;
const HOOK_COUNT = 5;

const connectionStats = { count: 0 };

const tickerSubscriber = $((key: string, { onData }: { onData: (data: TickMessage) => void }) => {
  connectionStats.count++;
  const state = { tick: 0 };

  const timer = setInterval(() => {
    state.tick++;
    onData({
      id: state.tick,
      text: `Tick #${state.tick} from "${key}" (conn #${connectionStats.count})`,
      timestamp: Date.now(),
    });
  }, 1500);

  return {
    unsubscribe: () => {
      clearInterval(timer);
    },
  };
});

const SubscriptionCard = component$<{ cardId: number }>(({ cardId }) => {
  const sub = useSubscription<TickMessage>(SHARED_KEY, tickerSubscriber, {
    maxRetries: 5,
    retryInterval: 1000,
  });

  const statusColor = (s: SubscriptionStatus) => {
    switch (s) {
      case "live":
        return "#0a0";
      case "connecting":
        return "#fa0";
      case "disconnected":
        return "#c00";
      default:
        return "#666";
    }
  };

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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: "0", color: "#5bf" }}>Hook #{cardId}</h3>
        <span
          style={{
            display: "inline-block",
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: statusColor(sub.status),
          }}
        />
      </div>

      <p style={{ margin: "4px 0", fontSize: "11px", color: "#666" }}>
        key: <code>{SHARED_KEY}</code>
      </p>

      <p style={{ margin: "8px 0 4px", fontSize: "12px", color: "#aaa" }}>
        Status: <strong style={{ color: statusColor(sub.status) }}>{sub.status}</strong>
      </p>

      {sub.data ? (
        <div
          style={{
            background: "#1a1a2e",
            padding: "8px",
            borderRadius: "4px",
            marginTop: "8px",
          }}
        >
          <p style={{ margin: "0", fontSize: "12px", color: "#ccc", fontFamily: "monospace" }}>
            {sub.data.text}
          </p>
          <p style={{ margin: "2px 0 0", fontSize: "10px", color: "#666" }}>
            {new Date(sub.data.timestamp).toLocaleTimeString()}
          </p>
        </div>
      ) : (
        <p style={{ color: "#666", fontSize: "12px", margin: "8px 0" }}>Waiting...</p>
      )}

      <div style={{ display: "flex", gap: "4px", marginTop: "8px" }}>
        <button
          onClick$={() => sub.unsubscribe$()}
          style={{
            fontSize: "10px",
            padding: "4px 8px",
            background: "#533",
            color: "#faa",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          unsub
        </button>
        <button
          onClick$={() => sub.reconnect$()}
          style={{
            fontSize: "10px",
            padding: "4px 8px",
            background: "#353",
            color: "#afa",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          reconnect
        </button>
      </div>
    </div>
  );
});

const DedupTab = component$(() => {
  const stats = useStore({
    connectionCount: 0,
    observerCount: 0,
    status: null as SubscriptionStatus | null,
  });

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    const update = () => {
      stats.connectionCount = connectionStats.count;
      stats.observerCount = subscriptionRegistry._getObserverCount(HASHED_KEY);
      stats.status = subscriptionRegistry.getStatus(HASHED_KEY);
    };
    update();
    const id = setInterval(update, 500);
    cleanup(() => clearInterval(id));
  });

  return (
    <div>
      <h2>Subscription Connection Dedup Demo</h2>
      <p>
        {HOOK_COUNT} independent <code>useSubscription</code> hooks sharing the{" "}
        <strong>same key</strong> (<code>{SHARED_KEY}</code>). Only <strong>1 connection</strong> is
        created.
      </p>

      {/* Stats panel */}
      <div
        style={{
          background: "#1a1a2e",
          padding: "16px",
          borderRadius: "8px",
          marginBottom: "24px",
        }}
      >
        <h3 style={{ margin: "0 0 12px 0", color: "#fff" }}>Connection Stats (auto-refresh)</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
          <div>
            <p style={{ margin: "0", fontSize: "11px", color: "#888" }}>subscriberFn calls</p>
            <p style={{ margin: "4px 0 0", fontSize: "24px", color: "#5f5", fontWeight: "bold" }}>
              {stats.connectionCount}
            </p>
            <p style={{ margin: "2px 0 0", fontSize: "10px", color: "#555" }}>
              (should be 1, not {HOOK_COUNT})
            </p>
          </div>
          <div>
            <p style={{ margin: "0", fontSize: "11px", color: "#888" }}>Active observers</p>
            <p style={{ margin: "4px 0 0", fontSize: "24px", color: "#5bf", fontWeight: "bold" }}>
              {stats.observerCount}
            </p>
            <p style={{ margin: "2px 0 0", fontSize: "10px", color: "#555" }}>(one per hook)</p>
          </div>
          <div>
            <p style={{ margin: "0", fontSize: "11px", color: "#888" }}>Connection status</p>
            <p
              style={{
                margin: "4px 0 0",
                fontSize: "24px",
                fontWeight: "bold",
                color:
                  stats.status === "live"
                    ? "#0a0"
                    : stats.status === "connecting"
                      ? "#fa0"
                      : stats.status === "disconnected"
                        ? "#c00"
                        : "#666",
              }}
            >
              {stats.status ?? "none"}
            </p>
          </div>
        </div>
      </div>

      {/* Explanation */}
      <div
        style={{
          background: "#1e2a1e",
          border: "1px solid #3a5a3a",
          padding: "16px",
          borderRadius: "8px",
          marginBottom: "24px",
        }}
      >
        <h3 style={{ margin: "0 0 8px 0", color: "#8f8" }}>How it works</h3>
        <ul style={{ margin: "0", paddingLeft: "20px", fontSize: "13px", color: "#ccc" }}>
          <li>
            <strong>First hook</strong> calls <code>subscriptionRegistry.attach()</code> -- creates
            the real subscriber connection
          </li>
          <li>
            <strong>Hooks 2-5</strong> call <code>attach()</code> -- join the existing connection,
            immediately receive latest data
          </li>
          <li>
            <strong>Each hook</strong> maintains its own <code>useStore</code> state (UI
            independence)
          </li>
          <li>
            <strong>Last hook unsubscribes</strong> -- <code>detach()</code> closes the shared
            connection (calls <code>unsubscribe</code> exactly once)
          </li>
        </ul>
      </div>

      <h3>{HOOK_COUNT} Hooks, Same Key, 1 Connection</h3>

      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <SubscriptionCard cardId={1} />
        <SubscriptionCard cardId={2} />
        <SubscriptionCard cardId={3} />
        <SubscriptionCard cardId={4} />
        <SubscriptionCard cardId={5} />
      </div>

      <div
        style={{
          marginTop: "24px",
          padding: "16px",
          background: "#111",
          borderRadius: "8px",
        }}
      >
        <h3 style={{ margin: "0 0 8px 0" }}>How to verify:</h3>
        <ol style={{ margin: "0", paddingLeft: "20px", fontSize: "14px", color: "#ccc" }}>
          <li>
            Stats panel shows <strong>subscriberFn calls = 1</strong> (not 5) -- proving a single
            shared connection
          </li>
          <li>
            All 5 cards show the same tick data with <code>conn #1</code>
            -- confirming they share the connection
          </li>
          <li>
            Click <strong>"unsub"</strong> on one card -- stats shows observers drop to 4, other
            cards keep receiving
          </li>
          <li>
            Click <strong>"unsub" on all 5</strong> -- connection closes (observers = 0, status =
            none)
          </li>
          <li>
            Click <strong>"reconnect"</strong> on any card -- a new connection is created
            (subscriberFn calls increments, <code>conn #</code> changes)
          </li>
          <li>
            Click <strong>"reconnect"</strong> on another card -- it joins the existing connection
            (subscriberFn calls stays the same)
          </li>
        </ol>
      </div>
    </div>
  );
});

// ── Tab 3: SSR + SWR + Subscription ──

const SWR_SUB_CODE = `// Layer 1: SSR
const loader = useMessagesLoader(); // routeLoader$

// Layer 2: SWR with SSR fallback
const swr = useSWR("/api/messages", fetcher$, {
  fallbackData: loader.value,
});

// Layer 3: Subscription -> SWR cache injection
useSubscription("chat", subscriber$, {
  onData$: $(async (msgs) => {
    swr.mutate$((cur) => [...(cur ?? []), ...msgs], { revalidate: false });
  }),
});`;

const SWRSubscriptionTab = component$<{ fallbackData: Message[] }>(({ fallbackData }) => {
  const swr = useSWR<Message[]>(
    "/api/messages",
    $(async (ctx) => {
      const res = await fetch("/api/messages", { signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
    {
      fallbackData,
      freshness: "slow",
    },
  );

  const sub = useSubscription<Message[]>(
    "chat-messages",
    $((key, { onData }) => {
      let msgId = 100;
      const names = ["Alice", "Bob", "Charlie", "Diana"];
      const phrases = [
        "Hello!",
        "How's it going?",
        "Great weather today!",
        "Anyone there?",
        "Check this out!",
        "LOL",
        "Interesting...",
      ];

      const timer = setInterval(() => {
        const user = names[Math.floor(Math.random() * names.length)];
        const text = phrases[Math.floor(Math.random() * phrases.length)];
        msgId++;
        const newMsg: Message = { id: msgId, text, user, timestamp: Date.now() };
        onData([newMsg]);
      }, 3000);

      return { unsubscribe: () => clearInterval(timer) };
    }),
    {
      maxRetries: 5,
      onData$: $(async (newMessages: Message[]) => {
        swr.mutate$((current) => [...(current ?? []), ...newMessages], { revalidate: false });
      }),
    },
  );

  const statusColor = (s: string) => {
    switch (s) {
      case "live":
        return "#0a0";
      case "connecting":
        return "#fa0";
      case "disconnected":
        return "#c00";
      default:
        return "#666";
    }
  };

  return (
    <div>
      <h2>SSR + SWR + Subscription</h2>
      <p>
        Three-layer architecture: <code>routeLoader$</code> (SSR fallback) +<code>useSWR</code>{" "}
        (cache) + <code>useSubscription</code> (real-time updates). New messages are injected into
        the SWR cache via <code>onData$</code> callback.
      </p>

      <CodeBlock code={SWR_SUB_CODE} />

      <div style="display: flex; gap: 16px; margin: 16px 0; align-items: center; font-size: 13px;">
        <span>
          Subscription: <strong style={`color: ${statusColor(sub.status)}`}>{sub.status}</strong>
        </span>
        <span>
          SWR status: <code>{swr.status}</code>
        </span>
        <span>
          Messages: <code>{swr.data?.length ?? 0}</code>
        </span>
        <button onClick$={() => sub.unsubscribe$()}>Stop</button>
        <button onClick$={() => sub.reconnect$()}>Restart</button>
      </div>

      <div style="border: 1px solid #ddd; border-radius: 6px; padding: 12px; max-height: 300px; overflow-y: auto;">
        {swr.data && swr.data.length > 0 ? (
          <ul style="list-style: none; padding: 0; margin: 0;">
            {swr.data.map((msg) => (
              <li
                key={msg.id}
                style="padding: 4px 0; border-bottom: 1px solid #eee; font-size: 13px;"
              >
                <strong>{msg.user}:</strong> {msg.text}{" "}
                <span style="color: #999; font-size: 11px;">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </span>
                {msg.id >= 100 && <span style="color: #07a; font-size: 10px;"> (realtime)</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p style="color: #999;">No messages yet.</p>
        )}
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

// ── Page ──

export default component$(() => {
  const loader = useMessagesLoader();

  return (
    <DemoPage
      title="useSubscription"
      description="Real-time data subscriptions with automatic reconnection, connection deduplication, and SSR+SWR integration."
    >
      <CodeBlock q:slot="code" code={CORE_CODE} />

      <Tabs tabs={[...TABS]}>
        <SubscriptionTab q:slot="subscription" />
        <DedupTab q:slot="dedup" />
        <SWRSubscriptionTab q:slot="swr-sub" fallbackData={loader.value} />
      </Tabs>
    </DemoPage>
  );
});
