import { describe, it, expect } from "vitest";
import { toSWRError } from "../../src/utils/error.ts";

describe("toSWRError", () => {
  describe("network errors", () => {
    it("should classify TypeError as network error", () => {
      const err = new TypeError("Failed to fetch");
      const result = toSWRError(err);
      expect(result.type).toBe("network");
      expect(result.message).toBe("Failed to fetch");
      expect(result.retryCount).toBe(0);
      expect(result.timestamp).toBeGreaterThan(0);
      expect(result.original).toBe(err);
    });

    it("should classify TypeError with network message", () => {
      const err = new TypeError("NetworkError when attempting to fetch");
      const result = toSWRError(err);
      expect(result.type).toBe("network");
    });
  });

  describe("http errors", () => {
    it("should classify Response-like objects as http errors", () => {
      const err = { status: 404, statusText: "Not Found" };
      const result = toSWRError(err);
      expect(result.type).toBe("http");
      expect(result.status).toBe(404);
      expect(result.message).toContain("404");
    });

    it("should classify errors with status property", () => {
      const err = new Error("Server error");
      (err as any).status = 500;
      const result = toSWRError(err);
      expect(result.type).toBe("http");
      expect(result.status).toBe(500);
    });

    it("should NOT classify as http error when status is out of valid range", () => {
      const negativeStatus = { status: -1, statusText: "Invalid" };
      expect(toSWRError(negativeStatus).type).toBe("unknown");
      expect(toSWRError(negativeStatus).status).toBeUndefined();

      const tooHighStatus = { status: 1000, statusText: "Invalid" };
      expect(toSWRError(tooHighStatus).type).toBe("unknown");
      expect(toSWRError(tooHighStatus).status).toBeUndefined();

      const zeroStatus = { status: 0 };
      expect(toSWRError(zeroStatus).type).toBe("unknown");
    });

    it("should accept valid HTTP status codes at boundaries", () => {
      expect(toSWRError({ status: 100 }).type).toBe("http");
      expect(toSWRError({ status: 100 }).status).toBe(100);
      expect(toSWRError({ status: 599 }).type).toBe("http");
      expect(toSWRError({ status: 599 }).status).toBe(599);
    });
  });

  describe("timeout errors", () => {
    it("should classify DOMException with TimeoutError name", () => {
      const err = new DOMException("The operation timed out", "TimeoutError");
      const result = toSWRError(err);
      expect(result.type).toBe("timeout");
      expect(result.message).toContain("The operation timed out");
    });

    it("should classify errors with timeout-related messages", () => {
      const err = new Error("timeout");
      const result = toSWRError(err);
      expect(result.type).toBe("timeout");
    });
  });

  describe("abort errors", () => {
    it("should classify DOMException with AbortError name", () => {
      const err = new DOMException("The operation was aborted", "AbortError");
      const result = toSWRError(err);
      expect(result.type).toBe("abort");
    });

    it("should classify errors with abort name", () => {
      const err = new Error("Aborted");
      err.name = "AbortError";
      const result = toSWRError(err);
      expect(result.type).toBe("abort");
    });
  });

  describe("parse errors", () => {
    it("should classify SyntaxError as parse error", () => {
      const err = new SyntaxError("Unexpected token");
      const result = toSWRError(err);
      expect(result.type).toBe("parse");
    });
  });

  describe("unknown errors", () => {
    it("should classify generic Error as unknown", () => {
      const err = new Error("Something went wrong");
      const result = toSWRError(err);
      expect(result.type).toBe("unknown");
      expect(result.message).toBe("Something went wrong");
    });

    it("should handle string errors", () => {
      const result = toSWRError("string error");
      expect(result.type).toBe("unknown");
      expect(result.message).toBe("string error");
    });

    it("should handle null/undefined", () => {
      const result = toSWRError(null);
      expect(result.type).toBe("unknown");
      expect(result.message).toBe("Unknown error");
    });

    it("should handle number errors", () => {
      const result = toSWRError(42);
      expect(result.type).toBe("unknown");
      expect(result.message).toBe("42");
    });
  });

  describe("retryCount", () => {
    it("should default retryCount to 0", () => {
      const result = toSWRError(new Error("test"));
      expect(result.retryCount).toBe(0);
    });

    it("should accept custom retryCount", () => {
      const result = toSWRError(new Error("test"), 3);
      expect(result.retryCount).toBe(3);
    });
  });

  describe("stack trace", () => {
    it("should capture stack from Error objects", () => {
      const err = new Error("test");
      const result = toSWRError(err);
      expect(result.stack).toBeDefined();
    });

    it("should not have stack for non-Error objects", () => {
      const result = toSWRError("string error");
      expect(result.stack).toBeUndefined();
    });
  });
});
