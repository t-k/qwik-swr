import { component$, Slot } from "@builder.io/qwik";
import { Link, useLocation } from "@builder.io/qwik-city";

const NAV_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/demo/use-swr/", label: "useSWR" },
  { href: "/demo/use-subscription/", label: "useSubscription" },
  { href: "/demo/use-mutation/", label: "useMutation" },
  { href: "/demo/cache/", label: "cache" },
  { href: "/demo/freshness/", label: "FRESHNESS_PRESETS" },
  { href: "/demo/storage/", label: "storage" },
];

export default component$(() => {
  const loc = useLocation();

  return (
    <div>
      <nav style="background: #1a1a2e; padding: 12px 24px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap;">
        <strong style="color: #fff; margin-right: 8px;">qwik-swr</strong>
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            style={{
              color: loc.url.pathname === item.href ? "#5bf" : "#aab",
              textDecoration: "none",
              fontSize: "14px",
            }}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <main style="max-width: 960px; margin: 0 auto; padding: 24px;">
        <Slot />
      </main>
    </div>
  );
});
