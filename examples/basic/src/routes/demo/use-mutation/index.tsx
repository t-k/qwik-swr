import { component$, $, useSignal } from "@builder.io/qwik";
import { useSWR, useMutation } from "qwik-swr";
import type { Todo } from "~/lib/mock-db";
import { SWRStateInspector } from "~/components/swr-state";
import { DemoPage } from "~/components/demo-page";
import { CodeBlock } from "~/components/code-block";

const CORE_CODE = `const { mutate$, mutateAsync$, isPending, isError } = useMutation(
  $((input) => fetch("/api/todos", {
    method: "POST",
    body: JSON.stringify(input),
  }).then(r => r.json())),
  {
    invalidateKeys: ["/api/todos"],
    optimisticUpdate: {
      key: "/api/todos",
      updater$: $((current, input) => [...(current ?? []), { ...input }]),
    },
  },
);`;

export default component$(() => {
  const newTitle = useSignal("");

  const swr = useSWR<Todo[]>(
    "/api/todos",
    $(async (ctx) => {
      const res = await fetch("/api/todos", { signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
  );

  // useMutation with optimistic update and invalidation
  const mutation = useMutation<Todo, { title: string }>(
    $(async (input: { title: string }) => {
      const res = await fetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }),
    {
      invalidateKeys: ["/api/todos"],
      optimisticUpdate: {
        key: "/api/todos",
        updater$: $((current: Todo[] | undefined, input: { title: string }) => [
          ...(current ?? []),
          { id: Date.now(), title: input.title, completed: false },
        ]),
      },
    },
  );

  const handleAdd = $(async () => {
    const title = newTitle.value.trim();
    if (!title) return;
    newTitle.value = "";
    await mutation.mutate$({ title });
  });

  const handleAddAsync = $(async () => {
    const title = newTitle.value.trim();
    if (!title) return;
    newTitle.value = "";
    try {
      const result = await mutation.mutateAsync$({ title });
      console.log("Created:", result);
    } catch (err) {
      console.error("Failed:", err);
    }
  });

  return (
    <DemoPage
      title="useMutation"
      description="Independent mutation hook with isPending, optimisticUpdate, and invalidateKeys."
    >
      <CodeBlock q:slot="code" code={CORE_CODE} />

      <div style="display: flex; gap: 8px; margin: 16px 0; align-items: center;">
        <input
          type="text"
          placeholder="New todo title..."
          value={newTitle.value}
          onInput$={(e) => {
            newTitle.value = (e.target as HTMLInputElement).value;
          }}
          style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; flex: 1;"
        />
        <button onClick$={handleAdd} disabled={mutation.isPending}>
          {mutation.isPending ? "Adding..." : "mutate$"}
        </button>
        <button onClick$={handleAddAsync} disabled={mutation.isPending}>
          mutateAsync$
        </button>
      </div>

      <div style="margin: 8px 0; font-size: 13px; color: #666;">
        <strong>Mutation status:</strong>{" "}
        {mutation.isPending
          ? "pending"
          : mutation.isSuccess
            ? "success"
            : mutation.isError
              ? "error"
              : "idle"}
        {mutation.isError && <span style="color: #c00;"> - {mutation.error?.message}</span>}
      </div>

      {swr.isLoading && <p>Loading...</p>}

      {swr.data && (
        <ul>
          {swr.data.map((todo) => (
            <li key={todo.id} style={{ textDecoration: todo.completed ? "line-through" : "none" }}>
              {todo.title}
              {todo.id > 1000 && <span style="font-size: 12px; color: #999;"> (optimistic)</span>}
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
    </DemoPage>
  );
});
