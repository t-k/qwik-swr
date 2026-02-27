import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",

	forbidOnly: !!process.env.CI,
	retries: 1,
	workers: 1,

	reporter: "html",

	use: {
		baseURL: "http://localhost:5173",
		trace: "on-first-retry",
	},

	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],

	webServer: {
		command: "npm run dev",
		url: "http://localhost:5173",
		reuseExistingServer: !process.env.CI,
		timeout: 120 * 1000,
		cwd: "./examples/basic",
		stdout: "pipe",
		stderr: "pipe",
	},
});
