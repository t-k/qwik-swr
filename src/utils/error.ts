import type { SWRError, SWRErrorType, SerializableSWRError } from "../types/index.ts";

function classifyError(err: unknown): { type: SWRErrorType; status?: number } {
  // AbortError
  if (err instanceof DOMException && err.name === "AbortError") {
    return { type: "abort" };
  }
  if (err instanceof Error && err.name === "AbortError") {
    return { type: "abort" };
  }

  // TimeoutError
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return { type: "timeout" };
  }
  if (err instanceof Error && /timeout/i.test(err.message)) {
    return { type: "timeout" };
  }

  // HTTP error (has numeric status property in valid range) - checked before TypeError (SF-12)
  if (
    err != null &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as Record<string, unknown>).status === "number"
  ) {
    const status = (err as Record<string, unknown>).status as number;
    if (status >= 100 && status <= 599) {
      return { type: "http", status };
    }
  }

  // Network error (TypeError from fetch)
  if (err instanceof TypeError) {
    return { type: "network" };
  }

  // Parse error (SyntaxError from JSON.parse)
  if (err instanceof SyntaxError) {
    return { type: "parse" };
  }

  return { type: "unknown" };
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err == null) return "Unknown error";

  // HTTP-like objects
  const errObj = err as Record<string, unknown>;
  if (typeof err === "object" && "status" in err && "statusText" in err) {
    return `HTTP ${errObj.status}: ${errObj.statusText}`;
  }
  if (typeof err === "object" && "status" in err) {
    return `HTTP ${errObj.status}`;
  }

  return String(err);
}

/**
 * Convert any error into a structured SWRError.
 */
export function toSWRError(err: unknown, retryCount = 0): SWRError {
  const { type, status } = classifyError(err);
  const message = extractMessage(err);
  const stack = err instanceof Error ? err.stack : undefined;

  return {
    type,
    status,
    message,
    retryCount,
    timestamp: Date.now(),
    stack,
    original: err,
  };
}

/**
 * Strip non-serializable `original` field from SWRError for persistence.
 */
export function serializeSWRError(error: SWRError): SerializableSWRError {
  const { original: _, ...serializable } = error;
  return serializable;
}
