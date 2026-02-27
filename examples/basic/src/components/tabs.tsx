import { component$, useSignal, Slot } from "@builder.io/qwik";
import { useLocation } from "@builder.io/qwik-city";

export interface Tab {
  id: string;
  label: string;
}

export const Tabs = component$<{ tabs: Tab[]; defaultTab?: string }>(({ tabs, defaultTab }) => {
  const loc = useLocation();
  const tabFromUrl = loc.url.searchParams.get("tab");
  const initialTab =
    tabFromUrl && tabs.some((t) => t.id === tabFromUrl)
      ? tabFromUrl
      : (defaultTab ?? tabs[0]?.id ?? "");
  const activeTab = useSignal(initialTab);

  return (
    <div>
      <div style="display: flex; gap: 0; border-bottom: 2px solid #ddd; margin-bottom: 16px; flex-wrap: wrap;">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick$={() => {
              activeTab.value = tab.id;
              const url = new URL(window.location.href);
              url.searchParams.set("tab", tab.id);
              history.replaceState({}, "", url.toString());
            }}
            style={{
              padding: "8px 16px",
              border: "none",
              borderBottom:
                activeTab.value === tab.id ? "2px solid #0066cc" : "2px solid transparent",
              background: activeTab.value === tab.id ? "#f0f4ff" : "transparent",
              fontWeight: activeTab.value === tab.id ? "bold" : "normal",
              cursor: "pointer",
              fontSize: "14px",
              marginBottom: "-2px",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} style={{ display: activeTab.value === tab.id ? "block" : "none" }}>
          <Slot name={tab.id} />
        </div>
      ))}
    </div>
  );
});
