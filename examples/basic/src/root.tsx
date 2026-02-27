import { component$ } from "@builder.io/qwik";
import { QwikCityProvider, RouterOutlet, ServiceWorkerRegister } from "@builder.io/qwik-city";
import { SWRProvider } from "qwik-swr";

export default component$(() => {
  return (
    <QwikCityProvider>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>qwik-swr example</title>
        <style>{`
          body { font-family: system-ui, sans-serif; margin: 0; padding: 0; color: #1a1a1a; }
          a { color: #0066cc; }
          pre { background: #f5f5f5; padding: 8px 12px; border-radius: 4px; overflow-x: auto; font-size: 13px; }
          code { background: #f0f0f0; padding: 2px 4px; border-radius: 2px; font-size: 13px; }
          .code-block pre { background: none; padding: 0; border-radius: 0; margin: 0; }
          .code-block code { background: none; padding: 0; border-radius: 0; }
          button { cursor: pointer; padding: 6px 14px; border: 1px solid #ccc; border-radius: 4px; background: #fff; }
          button:hover { background: #f0f0f0; }
          button:disabled { opacity: 0.5; cursor: not-allowed; }
        `}</style>
      </head>
      <body>
        <SWRProvider
          config={{
            freshness: "normal",
            retry: 2,
            revalidateOn: ["focus", "reconnect"],
          }}
        >
          <RouterOutlet />
        </SWRProvider>
        <ServiceWorkerRegister />
      </body>
    </QwikCityProvider>
  );
});
