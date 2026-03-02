import { describe, it, expect } from "vitest";
import { isDisabledKey } from "../../src/utils/resolve-key.ts";

describe("isDisabledKey", () => {
  it("should return true for null", () => {
    expect(isDisabledKey(null)).toBe(true);
  });

  it("should return true for undefined", () => {
    expect(isDisabledKey(undefined)).toBe(true);
  });

  it("should return true for false", () => {
    expect(isDisabledKey(false)).toBe(true);
  });

  it("should return false for a string key", () => {
    expect(isDisabledKey("/api/users")).toBe(false);
  });

  it("should return false for an empty string", () => {
    expect(isDisabledKey("")).toBe(false);
  });

  it("should return false for an array key", () => {
    expect(isDisabledKey(["users", 1])).toBe(false);
  });

  it("should return false for an empty array", () => {
    expect(isDisabledKey([])).toBe(false);
  });
});
