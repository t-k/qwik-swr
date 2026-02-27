import type { VisibleTaskStrategy } from "@builder.io/qwik";
import type { Status, FetchStatus, Eagerness } from "../types/index.ts";

/**
 * Derive the Status from current state.
 *
 * Priority:
 *   1. data != null -> "success" (even with error or fetching)
 *   2. fetchStatus === "fetching" -> "loading" (includes retry during error)
 *   3. error != null -> "error"
 *   4. else -> "idle"
 */
export function deriveStatus(
  hasData: boolean,
  hasError: boolean,
  fetchStatus: FetchStatus,
): Status {
  if (hasData) return "success";
  if (fetchStatus === "fetching") return "loading";
  if (hasError) return "error";
  return "idle";
}

/**
 * Map our Eagerness enum to Qwik's VisibleTaskStrategy for useVisibleTask$.
 */
export function mapEagerness(eagerness: Eagerness): VisibleTaskStrategy {
  switch (eagerness) {
    case "visible":
      return "intersection-observer";
    case "load":
      return "document-ready";
    case "idle":
      return "document-idle";
  }
}
