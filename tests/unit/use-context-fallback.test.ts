import { describe, it, expect } from "vitest";
import { isContextNotFoundError } from "../../src/utils/context-error.ts";

// ═══════════════════════════════════════════════════════════════
// T030: useContext fallback error detection
// ═══════════════════════════════════════════════════════════════

describe("isContextNotFoundError (US4)", () => {
  it("should return true for Qwik context-not-found error (code 13)", () => {
    // Qwik throws: "Code(13): Actual value for useContext(xxx) can not be found..."
    const error = new Error(
      "Code(13): Actual value for useContext(swr-config) can not be found, " +
        "make sure some ancestor component has set a value using useContextProvider().",
    );
    expect(isContextNotFoundError(error)).toBe(true);
  });

  it("should return true for Qwik minified context error (Q-13)", () => {
    // In production builds, Qwik may use short error codes
    const error = new Error("Q-13");
    expect(isContextNotFoundError(error)).toBe(true);
  });

  it("should return false for unrelated errors", () => {
    expect(isContextNotFoundError(new Error("something broke"))).toBe(false);
    expect(isContextNotFoundError(new TypeError("x is not a function"))).toBe(false);
    expect(isContextNotFoundError(new RangeError("out of range"))).toBe(false);
  });

  it("should return false for non-Error values", () => {
    expect(isContextNotFoundError("string error")).toBe(false);
    expect(isContextNotFoundError(null)).toBe(false);
    expect(isContextNotFoundError(undefined)).toBe(false);
    expect(isContextNotFoundError(42)).toBe(false);
  });

  it("should return false for other Qwik error codes", () => {
    // Code 28: invalid context reference
    const error28 = new Error(
      'Code(28): The provided Context reference "xxx" is not a valid context created by createContextId()',
    );
    expect(isContextNotFoundError(error28)).toBe(false);

    // Code 4: crash while rendering
    const error4 = new Error("Code(4): Crash while rendering");
    expect(isContextNotFoundError(error4)).toBe(false);
  });
});
