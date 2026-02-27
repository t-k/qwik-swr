import { describe, it, expect } from "vitest";
import { resolveOptions } from "../../src/utils/resolve-options.ts";
import { FRESHNESS_PRESETS } from "../../src/types/index.ts";
import type { SWRConfig, SWROptions } from "../../src/types/index.ts";

describe("resolveOptions", () => {
  describe("hardcoded defaults", () => {
    it("should return defaults when no options provided", () => {
      const result = resolveOptions();
      expect(result.enabled).toBe(true);
      expect(result.eagerness).toBe("visible");
      expect(result.staleTime).toBe(FRESHNESS_PRESETS.normal.staleTime);
      expect(result.cacheTime).toBe(FRESHNESS_PRESETS.normal.cacheTime);
      expect(result.dedupingInterval).toBe(FRESHNESS_PRESETS.normal.dedupingInterval);
      expect(result.revalidateOn).toEqual(["focus", "reconnect"]);
      expect(result.refreshInterval).toBe(0);
      expect(result.retry).toBe(3);
      expect(result.retryInterval).toBe(1000);
      expect(result.timeout).toBe(30_000);
    });
  });

  describe("freshness presets", () => {
    it("should apply volatile preset", () => {
      const result = resolveOptions(undefined, { freshness: "volatile" });
      expect(result.staleTime).toBe(0);
      expect(result.cacheTime).toBe(0);
      expect(result.dedupingInterval).toBe(2_000);
    });

    it("should apply static preset with MAX_SAFE_INTEGER", () => {
      const result = resolveOptions(undefined, { freshness: "static" });
      expect(result.staleTime).toBe(Number.MAX_SAFE_INTEGER);
      expect(result.cacheTime).toBe(Number.MAX_SAFE_INTEGER);
      expect(result.dedupingInterval).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("should apply eager preset", () => {
      const result = resolveOptions(undefined, { freshness: "eager" });
      expect(result.staleTime).toBe(0);
      expect(result.cacheTime).toBe(30_000);
    });

    it("should apply all 6 presets correctly", () => {
      for (const preset of ["volatile", "eager", "fast", "normal", "slow", "static"] as const) {
        const result = resolveOptions(undefined, { freshness: preset });
        expect(result.staleTime).toBe(FRESHNESS_PRESETS[preset].staleTime);
        expect(result.cacheTime).toBe(FRESHNESS_PRESETS[preset].cacheTime);
        expect(result.dedupingInterval).toBe(FRESHNESS_PRESETS[preset].dedupingInterval);
      }
    });
  });

  describe("provider + hook merge", () => {
    it("should apply provider config over defaults", () => {
      const providerConfig: SWRConfig = {
        freshness: "slow",
        retry: 5,
      };
      const result = resolveOptions(providerConfig);
      expect(result.staleTime).toBe(FRESHNESS_PRESETS.slow.staleTime);
      expect(result.retry).toBe(5);
    });

    it("should apply hook options over provider config", () => {
      const providerConfig: SWRConfig = {
        freshness: "slow",
        retry: 5,
      };
      const hookOptions: SWROptions = {
        retry: 1,
        staleTime: 999,
      };
      const result = resolveOptions(providerConfig, hookOptions);
      expect(result.retry).toBe(1);
      expect(result.staleTime).toBe(999);
    });

    it("should use hook freshness over provider freshness", () => {
      const providerConfig: SWRConfig = { freshness: "slow" };
      const hookOptions: SWROptions = { freshness: "volatile" };
      const result = resolveOptions(providerConfig, hookOptions);
      expect(result.staleTime).toBe(0);
      expect(result.cacheTime).toBe(0);
    });
  });

  describe("priority order: hook > provider > preset > hardcoded", () => {
    it("should allow hook staleTime to override preset staleTime", () => {
      const hookOptions: SWROptions = {
        freshness: "static",
        staleTime: 5000,
      };
      const result = resolveOptions(undefined, hookOptions);
      expect(result.staleTime).toBe(5000);
      // cacheTime should still come from static preset
      expect(result.cacheTime).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe("JSON.stringify compatibility (T039)", () => {
    it("should serialize static preset values with JSON.stringify (no Infinity)", () => {
      const result = resolveOptions(undefined, { freshness: "static" });
      const serialized = JSON.stringify({
        staleTime: result.staleTime,
        cacheTime: result.cacheTime,
        dedupingInterval: result.dedupingInterval,
      });
      const parsed = JSON.parse(serialized);
      expect(parsed.staleTime).toBe(Number.MAX_SAFE_INTEGER);
      expect(parsed.cacheTime).toBe(Number.MAX_SAFE_INTEGER);
      expect(parsed.dedupingInterval).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("should not use Infinity in any preset", () => {
      for (const preset of ["volatile", "eager", "fast", "normal", "slow", "static"] as const) {
        const config = FRESHNESS_PRESETS[preset];
        expect(Number.isFinite(config.staleTime)).toBe(true);
        expect(Number.isFinite(config.cacheTime)).toBe(true);
        expect(Number.isFinite(config.dedupingInterval)).toBe(true);
      }
    });
  });

  describe("retry normalization", () => {
    it("should convert retry=true to 3", () => {
      const result = resolveOptions(undefined, { retry: true });
      expect(result.retry).toBe(3);
    });

    it("should convert retry=false to 0", () => {
      const result = resolveOptions(undefined, { retry: false });
      expect(result.retry).toBe(0);
    });

    it("should keep numeric retry as-is", () => {
      const result = resolveOptions(undefined, { retry: 7 });
      expect(result.retry).toBe(7);
    });
  });
});
