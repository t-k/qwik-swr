import { component$, $, useSignal, useVisibleTask$ } from "@builder.io/qwik";
import {
  createMemoryStorage,
  createLocalStorage,
  createIndexedDBStorage,
  createHybridStorage,
  createBatchedStorage,
} from "qwik-swr/storage";
import { Tabs } from "~/components/tabs";
import { DemoPage } from "~/components/demo-page";
import { CodeBlock } from "~/components/code-block";

const TABS = [
  { id: "backends", label: "Backends" },
  { id: "hybrid", label: "Hybrid" },
  { id: "batched", label: "Batched" },
] as const;

const CORE_CODE = `import { initSWR } from "qwik-swr";
import { createLocalStorage, createIndexedDBStorage } from "qwik-swr/storage";

// localStorage backend
initSWR({ storage: createLocalStorage({ prefix: "my-app:" }) });

// IndexedDB backend
initSWR({ storage: createIndexedDBStorage({ dbName: "my-app" }) });`;

// ── Tab 1: Backends ──

const BACKEND_LS_CODE = `import { createLocalStorage } from "qwik-swr/storage";

const storage = createLocalStorage({ prefix: "demo:", maxSize: 100 });
storage.set("my-key", { data: { name: "Alice" }, timestamp: Date.now() });
storage.get("my-key"); // => { data: { name: "Alice" }, timestamp: ... }`;

const BACKEND_IDB_CODE = `import { createIndexedDBStorage } from "qwik-swr/storage";

const storage = createIndexedDBStorage({ dbName: "my-app", storeName: "cache" });
await storage.set("my-key", { data: { name: "Bob" }, timestamp: Date.now() });
await storage.get("my-key"); // => { data: { name: "Bob" }, timestamp: ... }`;

interface StorageEntry {
  key: string;
  value: string;
}

const BackendsTab = component$(() => {
  const lsEntries = useSignal<StorageEntry[]>([]);
  const idbEntries = useSignal<StorageEntry[]>([]);
  const lsStatus = useSignal("");
  const idbStatus = useSignal("");

  const lsStorage = useSignal<ReturnType<typeof createLocalStorage> | null>(null);
  const idbStorage = useSignal<ReturnType<typeof createIndexedDBStorage> | null>(null);

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(() => {
    lsStorage.value = createLocalStorage({ prefix: "demo:" });
    idbStorage.value = createIndexedDBStorage({ dbName: "demo-storage", storeName: "cache" });
  });

  const refreshLS = $(async () => {
    if (!lsStorage.value) return;
    const keys = lsStorage.value.keys() as string[];
    const entries: StorageEntry[] = [];
    for (const key of keys) {
      const entry = lsStorage.value.get(key);
      entries.push({ key, value: JSON.stringify(entry, null, 2) });
    }
    lsEntries.value = entries;
  });

  const refreshIDB = $(async () => {
    if (!idbStorage.value) return;
    const keys = (await idbStorage.value.keys()) as string[];
    const entries: StorageEntry[] = [];
    for (const key of keys) {
      const entry = await idbStorage.value.get(key);
      entries.push({ key, value: JSON.stringify(entry, null, 2) });
    }
    idbEntries.value = entries;
  });

  const handleLSWrite = $(async () => {
    if (!lsStorage.value) return;
    const id = Math.floor(Math.random() * 1000);
    const key = `user-${id}`;
    lsStorage.value.set(
      key as never,
      {
        data: { id, name: `User ${id}`, createdAt: new Date().toISOString() },
        timestamp: Date.now(),
      } as never,
    );
    lsStatus.value = `Wrote "${key}" to localStorage`;
    await refreshLS();
  });

  const handleIDBWrite = $(async () => {
    if (!idbStorage.value) return;
    const id = Math.floor(Math.random() * 1000);
    const key = `item-${id}`;
    await idbStorage.value.set(
      key as never,
      {
        data: { id, title: `Item ${id}`, createdAt: new Date().toISOString() },
        timestamp: Date.now(),
      } as never,
    );
    idbStatus.value = `Wrote "${key}" to IndexedDB`;
    await refreshIDB();
  });

  const handleLSClear = $(async () => {
    if (!lsStorage.value) return;
    lsStorage.value.clear();
    lsStatus.value = "Cleared localStorage";
    await refreshLS();
  });

  const handleIDBClear = $(async () => {
    if (!idbStorage.value) return;
    await idbStorage.value.clear();
    idbStatus.value = "Cleared IndexedDB";
    await refreshIDB();
  });

  return (
    <div>
      <h2>Storage Backends</h2>
      <p>
        qwik-swr provides 5 storage backends. This demo lets you interact with{" "}
        <code>localStorage</code> and <code>IndexedDB</code> directly.
      </p>

      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          margin: "16px 0",
          fontSize: "13px",
        }}
      >
        <thead>
          <tr style={{ borderBottom: "2px solid #ddd" }}>
            <th style={{ textAlign: "left", padding: "8px" }}>Backend</th>
            <th style={{ textAlign: "left", padding: "8px" }}>Async</th>
            <th style={{ textAlign: "left", padding: "8px" }}>Persistent</th>
            <th style={{ textAlign: "left", padding: "8px" }}>Best for</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: "8px" }}>
              <code>createMemoryStorage</code>
            </td>
            <td style={{ padding: "8px" }}>No</td>
            <td style={{ padding: "8px" }}>No</td>
            <td style={{ padding: "8px" }}>Default, fast in-memory cache with LRU eviction</td>
          </tr>
          <tr style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: "8px" }}>
              <code>createLocalStorage</code>
            </td>
            <td style={{ padding: "8px" }}>No</td>
            <td style={{ padding: "8px" }}>Yes</td>
            <td style={{ padding: "8px" }}>Small data, synchronous access, namespace prefix</td>
          </tr>
          <tr style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: "8px" }}>
              <code>createIndexedDBStorage</code>
            </td>
            <td style={{ padding: "8px" }}>Yes</td>
            <td style={{ padding: "8px" }}>Yes</td>
            <td style={{ padding: "8px" }}>Large data, structured storage</td>
          </tr>
          <tr style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: "8px" }}>
              <code>createHybridStorage</code>
            </td>
            <td style={{ padding: "8px" }}>Conditional</td>
            <td style={{ padding: "8px" }}>Yes</td>
            <td style={{ padding: "8px" }}>Fast reads (memory) + persistence (disk)</td>
          </tr>
          <tr style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: "8px" }}>
              <code>createBatchedStorage</code>
            </td>
            <td style={{ padding: "8px" }}>Yes (flush)</td>
            <td style={{ padding: "8px" }}>Depends on base</td>
            <td style={{ padding: "8px" }}>High-frequency writes, debounced flush</td>
          </tr>
        </tbody>
      </table>

      {/* localStorage section */}
      <h3>localStorage</h3>
      <CodeBlock code={BACKEND_LS_CODE} />

      <div style="display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap;">
        <button onClick$={handleLSWrite}>Write random entry</button>
        <button onClick$={refreshLS}>Refresh</button>
        <button onClick$={handleLSClear}>Clear</button>
      </div>

      {lsStatus.value && (
        <p style="font-size: 13px; color: #07a; margin: 4px 0;">{lsStatus.value}</p>
      )}

      {lsEntries.value.length > 0 && (
        <div
          style={{
            background: "#1a1a2e",
            borderRadius: "6px",
            padding: "12px",
            maxHeight: "200px",
            overflowY: "auto",
            marginBottom: "16px",
          }}
        >
          {lsEntries.value.map((entry) => (
            <div key={entry.key} style="margin-bottom: 8px;">
              <span style="color: #5bf; font-size: 12px; font-family: monospace;">{entry.key}</span>
              <pre
                style={{
                  color: "#aab",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  margin: "2px 0 0",
                  whiteSpace: "pre-wrap",
                }}
              >
                {entry.value}
              </pre>
            </div>
          ))}
        </div>
      )}

      {lsEntries.value.length === 0 && lsStatus.value && (
        <p style="color: #999; font-size: 13px;">No entries in localStorage (prefix: demo:)</p>
      )}

      {/* IndexedDB section */}
      <h3>IndexedDB</h3>
      <CodeBlock code={BACKEND_IDB_CODE} />

      <div style="display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap;">
        <button onClick$={handleIDBWrite}>Write random entry</button>
        <button onClick$={refreshIDB}>Refresh</button>
        <button onClick$={handleIDBClear}>Clear</button>
      </div>

      {idbStatus.value && (
        <p style="font-size: 13px; color: #07a; margin: 4px 0;">{idbStatus.value}</p>
      )}

      {idbEntries.value.length > 0 && (
        <div
          style={{
            background: "#1a1a2e",
            borderRadius: "6px",
            padding: "12px",
            maxHeight: "200px",
            overflowY: "auto",
            marginBottom: "16px",
          }}
        >
          {idbEntries.value.map((entry) => (
            <div key={entry.key} style="margin-bottom: 8px;">
              <span style="color: #5bf; font-size: 12px; font-family: monospace;">{entry.key}</span>
              <pre
                style={{
                  color: "#aab",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  margin: "2px 0 0",
                  whiteSpace: "pre-wrap",
                }}
              >
                {entry.value}
              </pre>
            </div>
          ))}
        </div>
      )}

      {idbEntries.value.length === 0 && idbStatus.value && (
        <p style="color: #999; font-size: 13px;">No entries in IndexedDB (db: demo-storage)</p>
      )}

      <div
        style={{
          border: "1px solid #d4edda",
          background: "#f0fdf4",
          borderRadius: "6px",
          padding: "12px",
          marginTop: "16px",
          fontSize: "13px",
        }}
      >
        <strong>Tip:</strong> Open DevTools &gt; Application tab to see the entries persisted in
        localStorage (key prefix: <code>demo:</code>) and IndexedDB (database:{" "}
        <code>demo-storage</code>).
      </div>
    </div>
  );
});

// ── Tab 2: Hybrid ──

const HYBRID_CODE = `import { createMemoryStorage, createIndexedDBStorage, createHybridStorage } from "qwik-swr/storage";

const storage = createHybridStorage({
  memory: createMemoryStorage({ maxSize: 50 }),
  persistent: createIndexedDBStorage({ dbName: "my-app" }),
});

// get: memory first, then persistent (read-through)
// set: writes to both layers (write-through)
// keys: merged & deduplicated from both layers`;

const HybridTab = component$(() => {
  const memoryKeys = useSignal<string[]>([]);
  const persistentKeys = useSignal<string[]>([]);
  const hybridKeys = useSignal<string[]>([]);
  const lastAction = useSignal("");
  const lastGetResult = useSignal<{ source: string; value: string } | null>(null);

  const memStorage = useSignal<ReturnType<typeof createMemoryStorage> | null>(null);
  const idbStorage = useSignal<ReturnType<typeof createIndexedDBStorage> | null>(null);
  const hybridStorage = useSignal<ReturnType<typeof createHybridStorage> | null>(null);

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(() => {
    const mem = createMemoryStorage({ maxSize: 50 });
    const idb = createIndexedDBStorage({ dbName: "demo-hybrid", storeName: "cache" });
    const hybrid = createHybridStorage({ memory: mem, persistent: idb });
    memStorage.value = mem;
    idbStorage.value = idb;
    hybridStorage.value = hybrid;
  });

  const refreshAll = $(async () => {
    if (!memStorage.value || !idbStorage.value || !hybridStorage.value) return;
    memoryKeys.value = memStorage.value.keys() as string[];
    persistentKeys.value = (await idbStorage.value.keys()) as string[];
    const hk = hybridStorage.value.keys();
    hybridKeys.value = (hk instanceof Promise ? await hk : hk) as string[];
  });

  const handleWriteHybrid = $(async () => {
    if (!hybridStorage.value) return;
    const id = Math.floor(Math.random() * 1000);
    const key = `hybrid-${id}`;
    const result = hybridStorage.value.set(
      key as never,
      {
        data: { id, label: `Hybrid Entry ${id}` },
        timestamp: Date.now(),
      } as never,
    );
    if (result instanceof Promise) await result;
    lastAction.value = `set("${key}") -> wrote to memory + IndexedDB`;
    lastGetResult.value = null;
    await refreshAll();
  });

  const handleGetFromHybrid = $(async () => {
    if (!hybridStorage.value || hybridKeys.value.length === 0) return;
    const key = hybridKeys.value[hybridKeys.value.length - 1];
    const result = hybridStorage.value.get(key as never);
    const entry = result instanceof Promise ? await result : result;
    if (entry) {
      // Check whether the memory layer had it
      const memResult = memStorage.value?.get(key as never);
      const source = memResult ? "memory (hit)" : "persistent (fallback)";
      lastGetResult.value = { source, value: JSON.stringify(entry, null, 2) };
      lastAction.value = `get("${key}") -> ${source}`;
    }
  });

  const handleClearMemoryOnly = $(async () => {
    if (!memStorage.value) return;
    memStorage.value.clear();
    lastAction.value = "Cleared memory layer only (persistent still has data)";
    lastGetResult.value = null;
    await refreshAll();
  });

  const handleClearAll = $(async () => {
    if (!hybridStorage.value) return;
    const result = hybridStorage.value.clear();
    if (result instanceof Promise) await result;
    lastAction.value = "Cleared both memory + persistent layers";
    lastGetResult.value = null;
    await refreshAll();
  });

  return (
    <div>
      <h2>Hybrid Storage</h2>
      <p>
        <code>createHybridStorage</code> combines a fast memory layer with a persistent layer. Reads
        check memory first (read-through), writes go to both (write-through).
      </p>

      <CodeBlock code={HYBRID_CODE} />

      <div style="display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap;">
        <button onClick$={handleWriteHybrid}>Write (both layers)</button>
        <button onClick$={handleGetFromHybrid}>Get (last key)</button>
        <button onClick$={handleClearMemoryOnly}>Clear memory only</button>
        <button onClick$={handleClearAll}>Clear all</button>
        <button onClick$={refreshAll}>Refresh</button>
      </div>

      {lastAction.value && (
        <p style="font-size: 13px; color: #07a; margin: 8px 0;">{lastAction.value}</p>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "12px",
          margin: "16px 0",
        }}
      >
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: "6px",
            padding: "12px",
          }}
        >
          <h4 style={{ margin: "0 0 8px" }}>Memory Layer</h4>
          <p style="font-size: 12px; color: #666; margin: 0 0 8px;">
            Keys: {memoryKeys.value.length}
          </p>
          {memoryKeys.value.length > 0 ? (
            <ul style="margin: 0; padding-left: 16px; font-size: 12px; font-family: monospace;">
              {memoryKeys.value.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          ) : (
            <p style="color: #999; font-size: 12px; margin: 0;">Empty</p>
          )}
        </div>

        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: "6px",
            padding: "12px",
          }}
        >
          <h4 style={{ margin: "0 0 8px" }}>Persistent Layer (IndexedDB)</h4>
          <p style="font-size: 12px; color: #666; margin: 0 0 8px;">
            Keys: {persistentKeys.value.length}
          </p>
          {persistentKeys.value.length > 0 ? (
            <ul style="margin: 0; padding-left: 16px; font-size: 12px; font-family: monospace;">
              {persistentKeys.value.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          ) : (
            <p style="color: #999; font-size: 12px; margin: 0;">Empty</p>
          )}
        </div>
      </div>

      {lastGetResult.value && (
        <div
          style={{
            background: "#1a1a2e",
            borderRadius: "6px",
            padding: "12px",
            marginTop: "12px",
          }}
        >
          <p style="color: #5bf; font-size: 12px; margin: 0 0 4px;">
            Source: {lastGetResult.value.source}
          </p>
          <pre
            style={{
              color: "#aab",
              fontSize: "11px",
              fontFamily: "monospace",
              margin: 0,
              whiteSpace: "pre-wrap",
            }}
          >
            {lastGetResult.value.value}
          </pre>
        </div>
      )}

      <div
        style={{
          border: "1px solid #d4edda",
          background: "#f0fdf4",
          borderRadius: "6px",
          padding: "12px",
          marginTop: "16px",
          fontSize: "13px",
        }}
      >
        <strong>Try this:</strong> Write some entries, then click "Clear memory only". The memory
        layer becomes empty, but persistent still has data. Now click "Get (last key)" -- the hybrid
        storage reads through to IndexedDB and returns the entry.
      </div>
    </div>
  );
});

// ── Tab 3: Batched ──

const BATCHED_CODE = `import { createBatchedStorage, createIndexedDBStorage } from "qwik-swr/storage";

const base = createIndexedDBStorage({ dbName: "my-app" });
const storage = createBatchedStorage(base, { flushInterval: 200 });

// Writes are buffered, not immediately flushed
storage.set("key-1", entry1);
storage.set("key-2", entry2);
// Both are flushed together after 200ms

storage.flush();   // force flush
storage.dispose(); // cleanup`;

const BatchedTab = component$(() => {
  const pendingCount = useSignal(0);
  const flushCount = useSignal(0);
  const writeCount = useSignal(0);
  const baseEntryCount = useSignal(0);
  const flushInterval = useSignal(500);
  const lastAction = useSignal("");

  const batchedRef = useSignal<ReturnType<typeof createBatchedStorage> | null>(null);
  const baseRef = useSignal<ReturnType<typeof createLocalStorage> | null>(null);

  // Track pending writes manually since the batched storage doesn't expose count
  const pendingKeys = useSignal<string[]>([]);

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    const base = createLocalStorage({ prefix: "demo-batched:" });
    baseRef.value = base;

    // Wrap set to track flush counts
    const originalSet = base.set.bind(base);
    let localFlushCount = 0;
    base.set = ((key: never, entry: never) => {
      localFlushCount++;
      flushCount.value = localFlushCount;
      return originalSet(key, entry);
    }) as typeof base.set;

    const batched = createBatchedStorage(base, { flushInterval: flushInterval.value });
    batchedRef.value = batched;

    cleanup(() => {
      batched.dispose();
    });
  });

  const refreshBaseCount = $(() => {
    if (!baseRef.value) return;
    const keys = baseRef.value.keys() as string[];
    baseEntryCount.value = keys.length;
  });

  const handleBurstWrite = $(async () => {
    if (!batchedRef.value) return;
    const burst = 10;
    const newPending: string[] = [];
    for (let i = 0; i < burst; i++) {
      const id = writeCount.value + i;
      const key = `batch-${id}`;
      batchedRef.value.set(
        key as never,
        {
          data: { id, value: `Entry ${id}` },
          timestamp: Date.now(),
        } as never,
      );
      newPending.push(key);
    }
    writeCount.value += burst;
    pendingKeys.value = [...pendingKeys.value, ...newPending];
    pendingCount.value = pendingKeys.value.length;
    lastAction.value = `Queued ${burst} writes (total: ${writeCount.value}). Waiting for flush...`;

    // After flush interval, update
    setTimeout(async () => {
      pendingKeys.value = [];
      pendingCount.value = 0;
      await refreshBaseCount();
      lastAction.value = `Flushed! ${burst} writes batched into a single flush cycle.`;
    }, flushInterval.value + 100);
  });

  const handleForceFlush = $(async () => {
    if (!batchedRef.value) return;
    await batchedRef.value.flush();
    pendingKeys.value = [];
    pendingCount.value = 0;
    await refreshBaseCount();
    lastAction.value = "Force flushed all pending writes";
  });

  const handleClear = $(async () => {
    if (!batchedRef.value) return;
    const result = batchedRef.value.clear();
    if (result instanceof Promise) await result;
    await batchedRef.value.flush();
    pendingKeys.value = [];
    pendingCount.value = 0;
    writeCount.value = 0;
    flushCount.value = 0;
    await refreshBaseCount();
    lastAction.value = "Cleared all entries";
  });

  return (
    <div>
      <h2>Batched Storage</h2>
      <p>
        <code>createBatchedStorage</code> wraps any storage backend and batches writes together.
        Instead of writing each entry immediately, writes are buffered and flushed at a configurable
        interval.
      </p>

      <CodeBlock code={BATCHED_CODE} />

      <div
        style={{
          background: "#1a1a2e",
          borderRadius: "8px",
          padding: "16px",
          margin: "16px 0",
        }}
      >
        <h3 style={{ margin: "0 0 12px", color: "#fff" }}>Counters</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
          <div style={{ textAlign: "center" }}>
            <p style={{ color: "#888", fontSize: "12px", margin: "0 0 4px" }}>Pending Writes</p>
            <p style={{ color: "#fa5", fontSize: "24px", fontWeight: "bold", margin: 0 }}>
              {pendingCount.value}
            </p>
          </div>
          <div style={{ textAlign: "center" }}>
            <p style={{ color: "#888", fontSize: "12px", margin: "0 0 4px" }}>Base set() Calls</p>
            <p style={{ color: "#5f5", fontSize: "24px", fontWeight: "bold", margin: 0 }}>
              {flushCount.value}
            </p>
          </div>
          <div style={{ textAlign: "center" }}>
            <p style={{ color: "#888", fontSize: "12px", margin: "0 0 4px" }}>Total Writes</p>
            <p style={{ color: "#5bf", fontSize: "24px", fontWeight: "bold", margin: 0 }}>
              {writeCount.value}
            </p>
          </div>
        </div>
        <p style={{ color: "#666", fontSize: "12px", margin: "12px 0 0", textAlign: "center" }}>
          Flush interval: {flushInterval.value}ms | Base entries: {baseEntryCount.value}
        </p>
      </div>

      <div style="display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap;">
        <button onClick$={handleBurstWrite}>Burst write (10 entries)</button>
        <button onClick$={handleForceFlush}>Force flush</button>
        <button onClick$={handleClear}>Clear</button>
      </div>

      {lastAction.value && (
        <p style="font-size: 13px; color: #07a; margin: 8px 0;">{lastAction.value}</p>
      )}

      <div
        style={{
          border: "1px solid #d4edda",
          background: "#f0fdf4",
          borderRadius: "6px",
          padding: "12px",
          marginTop: "16px",
          fontSize: "13px",
        }}
      >
        <strong>Try this:</strong> Click "Burst write" to queue 10 entries at once. Watch the
        "Pending Writes" counter spike, then drop to 0 after {flushInterval.value}ms when the batch
        flushes. Compare "Total Writes" (individual set calls) vs "Base set() Calls" (actual writes
        to underlying storage) to see the batching effect.
      </div>
    </div>
  );
});

// ── Page ──

export default component$(() => {
  return (
    <DemoPage
      title="storage"
      description="5 pluggable storage backends for qwik-swr: memory, localStorage, IndexedDB, hybrid, and batched."
    >
      <CodeBlock q:slot="code" code={CORE_CODE} />

      <Tabs tabs={[...TABS]}>
        <BackendsTab q:slot="backends" />
        <HybridTab q:slot="hybrid" />
        <BatchedTab q:slot="batched" />
      </Tabs>
    </DemoPage>
  );
});
