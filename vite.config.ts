import { defineConfig } from "vite";
import { qwikVite } from "@builder.io/qwik/optimizer";
import { resolve } from "node:path";

export default defineConfig(() => ({
	build: {
		target: "es2020",
		lib: {
			entry: {
				index: resolve(__dirname, "./src/index.ts"),
				subscription: resolve(__dirname, "./src/subscription/index.ts"),
				storage: resolve(__dirname, "./storage/index.ts"),
				devtools: resolve(__dirname, "./devtools/index.ts"),
			},
			formats: ["es", "cjs"],
			fileName: (format, entryName) =>
				`${entryName}.qwik.${format === "es" ? "mjs" : "cjs"}`,
		},
		rollupOptions: {
			external: [/^@builder\.io\/qwik/],
		},
	},
	plugins: [qwikVite()],
}));
