import { component$ } from "@builder.io/qwik";
import { Link } from "@builder.io/qwik-city";

const DEMOS = [
  {
    href: "/demo/use-swr/",
    title: "useSWR",
    description:
      "Data fetching with caching, deduplication, revalidation, SSR integration, error handling, and focus/reconnect.",
  },
  {
    href: "/demo/use-subscription/",
    title: "useSubscription",
    description:
      "Real-time subscriptions with automatic reconnection, connection deduplication, and SSR+SWR integration.",
  },
  {
    href: "/demo/use-mutation/",
    title: "useMutation",
    description: "Independent mutation hook with optimistic updates and cache invalidation.",
  },
  {
    href: "/demo/cache/",
    title: "cache API",
    description: "Prefetch, export/import, cache.clear(), and SWRDevtools for cache inspection.",
  },
  {
    href: "/demo/freshness/",
    title: "FRESHNESS_PRESETS",
    description: "Compare volatile / normal / static presets side by side.",
  },
  {
    href: "/demo/storage/",
    title: "storage",
    description:
      "5 pluggable storage backends: memory, localStorage, IndexedDB, hybrid, and batched.",
  },
];

export default component$(() => {
  return (
    <div>
      <h1>qwik-swr Examples</h1>
      <p>Lightweight SWR data fetching library for Qwik. Select a demo below.</p>
      <div style="display: grid; gap: 12px; margin-top: 24px;">
        {DEMOS.map((demo) => (
          <Link
            key={demo.href}
            href={demo.href}
            style="display: block; border: 1px solid #ddd; border-radius: 6px; padding: 16px; text-decoration: none; color: inherit;"
          >
            <strong style="font-size: 16px;">{demo.title}</strong>
            <p style="margin: 4px 0 0; color: #666; font-size: 14px;">{demo.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
});
