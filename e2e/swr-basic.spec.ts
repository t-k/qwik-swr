import { test, expect } from "@playwright/test";

test.describe("useSWR basic data fetching", () => {
	test("should display fetched posts", async ({ page }) => {
		await page.goto("/demo/posts");

		// Should display post list after data loads
		const list = page.locator("ul");
		await expect(list).toBeVisible({ timeout: 10000 });

		// Should have at least one list item
		const items = list.locator("li");
		await expect(items.first()).toBeVisible();

		// Loading indicator should be gone after data loads
		await expect(page.locator("text=Loading...")).not.toBeVisible();
	});

	test("should display SWR state inspector with success status", async ({ page }) => {
		await page.goto("/demo/posts");

		// Wait for data to load
		await expect(page.locator("ul")).toBeVisible({ timeout: 10000 });

		// Status should show "success"
		await expect(page.locator("text=success").first()).toBeVisible();
	});
});
