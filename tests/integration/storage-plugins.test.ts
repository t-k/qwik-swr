import { describe, it, expect } from "vitest";
import { serializeSWRError } from "../../src/utils/error.ts";
import type { SWRError } from "../../src/types/index.ts";

// ═══════════════════════════════════════════════════════════════
// T041: SWRError serialize strips the `original` field
// ═══════════════════════════════════════════════════════════════

describe("T041: SWRError serialize strips the `original` field", () => {
  it("should remove the original field from SWRError", () => {
    const originalError = new TypeError("Failed to fetch");
    const swrError: SWRError = {
      type: "network",
      message: "Failed to fetch",
      retryCount: 0,
      timestamp: 1000,
      stack: "Error: Failed to fetch\n    at ...",
      original: originalError,
    };

    const serialized = serializeSWRError(swrError);

    expect(serialized).not.toHaveProperty("original");
  });

  it("should keep all other fields intact", () => {
    const swrError: SWRError = {
      type: "http",
      status: 404,
      message: "Not Found",
      retryCount: 2,
      timestamp: 5000,
      stack: "Error: Not Found\n    at ...",
      original: { status: 404, statusText: "Not Found" },
    };

    const serialized = serializeSWRError(swrError);

    expect(serialized.type).toBe("http");
    expect(serialized.status).toBe(404);
    expect(serialized.message).toBe("Not Found");
    expect(serialized.retryCount).toBe(2);
    expect(serialized.timestamp).toBe(5000);
    expect(serialized.stack).toBe("Error: Not Found\n    at ...");
  });

  it("should work when original is undefined", () => {
    const swrError: SWRError = {
      type: "unknown",
      message: "Something went wrong",
      retryCount: 0,
      timestamp: 3000,
    };

    const serialized = serializeSWRError(swrError);

    expect(serialized).not.toHaveProperty("original");
    expect(serialized.type).toBe("unknown");
    expect(serialized.message).toBe("Something went wrong");
  });

  it("should produce a JSON-serializable result", () => {
    const circularRef: Record<string, unknown> = {};
    circularRef.self = circularRef;

    const swrError: SWRError = {
      type: "network",
      message: "Network error",
      retryCount: 1,
      timestamp: 2000,
      original: circularRef, // Not serializable
    };

    const serialized = serializeSWRError(swrError);

    // Without original, it should be JSON-serializable
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });

  it("should produce a value that matches SerializableSWRError type shape", () => {
    const swrError: SWRError = {
      type: "timeout",
      message: "Request timed out",
      retryCount: 3,
      timestamp: 7000,
      stack: "Error: Request timed out",
      original: new DOMException("Timeout", "TimeoutError"),
    };

    const serialized = serializeSWRError(swrError);

    // Verify the shape matches SerializableSWRError (= Omit<SWRError, 'original'>)
    const keys = Object.keys(serialized);
    expect(keys).not.toContain("original");

    // All expected keys should be present
    expect(serialized).toHaveProperty("type");
    expect(serialized).toHaveProperty("message");
    expect(serialized).toHaveProperty("retryCount");
    expect(serialized).toHaveProperty("timestamp");
    expect(serialized).toHaveProperty("stack");
  });
});
