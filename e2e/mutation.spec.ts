import { test, expect } from "@playwright/test";

test.describe("useMutation todo creation", () => {
	test("should add a todo with optimistic update", async ({ page }) => {
		await page.goto("/demo/mutation");

		// Wait for initial todos to load
		const list = page.locator("ul");
		await expect(list).toBeVisible({ timeout: 10000 });

		// Count existing items
		const initialCount = await list.locator("li").count();

		// Type a new todo title and submit
		const input = page.locator('input[type="text"]');
		await input.fill("E2E Test Todo");
		await page.locator("button", { hasText: "mutate$" }).click();

		// Optimistic update should show the new item immediately
		await expect(list.locator("li")).toHaveCount(initialCount + 1, { timeout: 5000 });
		await expect(list.locator("text=E2E Test Todo")).toBeVisible();
	});

	test("should show mutation status transitions", async ({ page }) => {
		// Capture console errors
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(err.message));

		await page.goto("/demo/mutation");

		// Wait for initial load
		await expect(page.locator("ul")).toBeVisible({ timeout: 10000 });

		// Dismiss vite-error-overlay if present (dev server HMR artifacts)
		await page.evaluate(() => {
			document.querySelector("vite-error-overlay")?.remove();
		});

		// Initial state should be idle
		await expect(page.locator("text=idle").first()).toBeVisible();

		// Submit a new todo
		const input = page.locator('input[type="text"]');
		await input.fill("Status Test Todo");
		await page.locator("button", { hasText: "mutate$" }).click();

		// Should eventually show "success"
		await expect(page.locator("text=success").first()).toBeVisible({ timeout: 10000 });
	});
});
