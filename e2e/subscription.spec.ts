import { test, expect } from "@playwright/test";

test.describe("useSubscription real-time data", () => {
	test("should connect and receive tick messages", async ({ page }) => {
		await page.goto("/demo/realtime");

		// Status should eventually become "live" (ticks every 1.5s)
		await expect(page.locator("strong", { hasText: "live" })).toBeVisible({ timeout: 10000 });

		// Should show at least one tick message
		const messageList = page.locator("ul");
		await expect(messageList).toBeVisible({ timeout: 10000 });
		await expect(messageList.locator("li").first()).toBeVisible();

		// Message should contain "Tick #" text
		await expect(messageList.locator("li").first()).toContainText("Tick #");
	});

	test("should unsubscribe and disconnect", async ({ page }) => {
		await page.goto("/demo/realtime");

		// Wait for live status
		await expect(page.locator("strong", { hasText: "live" })).toBeVisible({ timeout: 10000 });

		// Click unsubscribe
		await page.locator("button", { hasText: "unsubscribe$" }).click();

		// Should show disconnected status
		await expect(page.locator("strong", { hasText: "disconnected" })).toBeVisible({ timeout: 5000 });
	});

	test("should reconnect after unsubscribe", async ({ page }) => {
		await page.goto("/demo/realtime");

		// Wait for live
		await expect(page.locator("strong", { hasText: "live" })).toBeVisible({ timeout: 10000 });

		// Unsubscribe
		await page.locator("button", { hasText: "unsubscribe$" }).click();
		await expect(page.locator("strong", { hasText: "disconnected" })).toBeVisible({ timeout: 5000 });

		// Reconnect
		await page.locator("button", { hasText: "reconnect$" }).click();

		// Should transition through connecting -> live
		await expect(page.locator("strong", { hasText: "live" })).toBeVisible({ timeout: 10000 });
	});

	test("should show boolean status flags correctly", async ({ page }) => {
		await page.goto("/demo/realtime");

		// Once live, isLive should be true
		await expect(page.locator("strong", { hasText: "live" })).toBeVisible({ timeout: 10000 });
		await expect(page.locator("text=isLive:")).toBeVisible();
		await expect(page.locator("code", { hasText: "true" }).first()).toBeVisible();
	});
});
