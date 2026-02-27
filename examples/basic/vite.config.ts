import { defineConfig } from "vite";
import { qwikVite } from "@builder.io/qwik/optimizer";
import { qwikCity } from "@builder.io/qwik-city/vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(() => {
  return {
    plugins: [qwikCity(), qwikVite(), tsconfigPaths()],
    server: {
      hmr: {
        timeout: 5000, // ping every 5s instead of 30s for faster debugging
      },
    },
    ssr: {
      noExternal: ["qwik-swr"],
    },
  };
});
