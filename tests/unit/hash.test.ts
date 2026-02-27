import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/utils/hash.ts";

describe("hashKey", () => {
  describe("string keys", () => {
    it("should prefix string keys with 's:'", () => {
      expect(hashKey("/api/users")).toBe("s:/api/users");
    });

    it("should handle empty string", () => {
      expect(hashKey("")).toBe("s:");
    });

    it("should preserve special characters", () => {
      expect(hashKey("/api/users?page=1&sort=name")).toBe("s:/api/users?page=1&sort=name");
    });
  });

  describe("array keys", () => {
    it("should prefix array keys with 'a:' and JSON.stringify", () => {
      expect(hashKey(["users", 1] as const)).toBe('a:["users",1]');
    });

    it("should handle array with mixed types", () => {
      expect(hashKey(["key", 42, true, null] as const)).toBe('a:["key",42,true,null]');
    });

    it("should handle single-element array", () => {
      expect(hashKey(["users"] as const)).toBe('a:["users"]');
    });

    it("should handle empty array", () => {
      expect(hashKey([] as const)).toBe("a:[]");
    });
  });

  describe("collision avoidance", () => {
    it("should not collide between string '1' and array [1]", () => {
      const stringHash = hashKey("1");
      const arrayHash = hashKey([1] as const);
      expect(stringHash).not.toBe(arrayHash);
    });

    it("should not collide between string and array with same content", () => {
      const stringHash = hashKey('["users",1]');
      const arrayHash = hashKey(["users", 1] as const);
      expect(stringHash).not.toBe(arrayHash);
    });

    it("should produce different hashes for different arrays", () => {
      const hash1 = hashKey(["users", 1] as const);
      const hash2 = hashKey(["users", 2] as const);
      expect(hash1).not.toBe(hash2);
    });

    it("should produce same hash for identical arrays", () => {
      const hash1 = hashKey(["users", 1] as const);
      const hash2 = hashKey(["users", 1] as const);
      expect(hash1).toBe(hash2);
    });
  });
});
