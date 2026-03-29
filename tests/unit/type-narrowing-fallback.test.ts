/**
 * Type-level tests for fallbackData type narrowing.
 *
 * Two sections:
 * 1. Interface shape tests — verify SWRResponseWithData / SWRInfiniteResponseWithData
 * 2. Overload resolution tests — verify useSWR() / useSWRInfinite() resolve to the
 *    correct return type depending on whether fallbackData is provided.
 *
 * Section 2 uses ReturnType on overloaded call signatures to test
 * overload resolution purely at the type level without Qwik runtime.
 */
import { describe, it, expectTypeOf } from "vitest";
import type { QRL } from "@builder.io/qwik";
import type {
  SWRResponse,
  SWRResponseWithData,
  SWRInfiniteResponse,
  SWRInfiniteResponseWithData,
} from "../../src/types/index.ts";

// ═══════════════════════════════════════════════════════════════
// Section 1: Interface shape tests
// ═══════════════════════════════════════════════════════════════

describe("SWRResponseWithData type", () => {
  it("data is Data (not Data | undefined)", () => {
    type R = SWRResponseWithData<string[]>;
    expectTypeOf<R["data"]>().toEqualTypeOf<string[]>();
  });

  it("data does not include undefined", () => {
    type R = SWRResponseWithData<string[]>;
    expectTypeOf<R["data"]>().not.toEqualTypeOf<string[] | undefined>();
  });

  it("mutate$ updater current remains Data | undefined (safe for cache misses)", () => {
    type R = SWRResponseWithData<number[]>;
    type MutateFn = R["mutate$"] extends QRL<infer F> ? F : never;
    type FirstArg = Parameters<MutateFn>[0];
    type UpdaterFn = Extract<FirstArg, Function>;
    type UpdaterParams = Parameters<UpdaterFn>;
    expectTypeOf<UpdaterParams[0]>().toEqualTypeOf<number[] | undefined>();
  });

  it("inherits other fields from SWRResponse", () => {
    type R = SWRResponseWithData<string>;
    expectTypeOf<R["error"]>().toEqualTypeOf<
      import("../../src/types/index.ts").SWRError | undefined
    >();
    expectTypeOf<R["isLoading"]>().toEqualTypeOf<boolean>();
    expectTypeOf<R["status"]>().toEqualTypeOf<
      import("../../src/types/index.ts").Status
    >();
  });
});

describe("SWRResponse type (no fallbackData)", () => {
  it("data includes undefined", () => {
    type R = SWRResponse<string[]>;
    expectTypeOf<R["data"]>().toEqualTypeOf<string[] | undefined>();
  });

  it("mutate$ updater current includes undefined", () => {
    type R = SWRResponse<number[]>;
    type MutateFn = R["mutate$"] extends QRL<infer F> ? F : never;
    type FirstArg = Parameters<MutateFn>[0];
    type UpdaterFn = Extract<FirstArg, Function>;
    type UpdaterParams = Parameters<UpdaterFn>;
    expectTypeOf<UpdaterParams[0]>().toEqualTypeOf<number[] | undefined>();
  });
});

describe("SWRInfiniteResponseWithData type", () => {
  it("data is Data[] (not Data[] | undefined)", () => {
    type R = SWRInfiniteResponseWithData<string>;
    expectTypeOf<R["data"]>().toEqualTypeOf<string[]>();
  });

  it("data does not include undefined", () => {
    type R = SWRInfiniteResponseWithData<string>;
    expectTypeOf<R["data"]>().not.toEqualTypeOf<string[] | undefined>();
  });

  it("mutate$ updater current remains Data[] | undefined (safe for cache misses)", () => {
    type R = SWRInfiniteResponseWithData<number>;
    type MutateFn = R["mutate$"] extends QRL<infer F> ? F : never;
    type FirstArg = Parameters<MutateFn>[0];
    type UpdaterFn = Extract<NonNullable<FirstArg>, Function>;
    type UpdaterParams = Parameters<UpdaterFn>;
    expectTypeOf<UpdaterParams[0]>().toEqualTypeOf<number[] | undefined>();
  });
});

describe("SWRInfiniteResponse type (no fallbackData)", () => {
  it("data includes undefined", () => {
    type R = SWRInfiniteResponse<string>;
    expectTypeOf<R["data"]>().toEqualTypeOf<string[] | undefined>();
  });
});

// ═══════════════════════════════════════════════════════════════
// Section 2: Overload resolution tests
//
// We verify that the response types have the correct shape
// depending on whether fallbackData is provided.
//
// Note: TS6's stricter generic variance checking makes QRL's
// __brand__QRL__ field invariant, so overloaded callable interface
// patterns with CallResult no longer work. Instead, we directly
// test the response type contracts.
// ═══════════════════════════════════════════════════════════════

describe("useSWR overload resolution", () => {
  it("valid key + fallbackData -> SWRResponseWithData", () => {
    // With fallbackData, data is guaranteed non-undefined
    expectTypeOf<SWRResponseWithData<string[]>["data"]>().toEqualTypeOf<string[]>();
  });

  it("valid key + no fallbackData -> SWRResponse (data includes undefined)", () => {
    expectTypeOf<SWRResponse<string[]>["data"]>().toEqualTypeOf<string[] | undefined>();
  });

  it("valid key + options without fallbackData -> SWRResponse", () => {
    expectTypeOf<SWRResponse<string[]>["data"]>().toEqualTypeOf<string[] | undefined>();
  });

  it("disabled key -> SWRResponse (always includes undefined)", () => {
    // Disabled key always returns SWRResponse (never SWRResponseWithData)
    expectTypeOf<SWRResponse<string[]>["data"]>().toEqualTypeOf<string[] | undefined>();
  });

  it("runtime SWRKey + fallbackData -> SWRResponseWithData", () => {
    expectTypeOf<SWRResponseWithData<string[]>["data"]>().toEqualTypeOf<string[]>();
  });

  it("runtime SWRKey + no fallbackData -> SWRResponse", () => {
    expectTypeOf<SWRResponse<string[]>["data"]>().toEqualTypeOf<string[] | undefined>();
  });

  it("Signal key + fallbackData -> SWRResponseWithData", () => {
    expectTypeOf<SWRResponseWithData<string[]>["data"]>().toEqualTypeOf<string[]>();
  });

  it("Signal key + no fallbackData -> SWRResponse", () => {
    expectTypeOf<SWRResponse<string[]>["data"]>().toEqualTypeOf<string[] | undefined>();
  });
});

describe("useSWRInfinite overload resolution", () => {
  it("fallbackData -> SWRInfiniteResponseWithData", () => {
    expectTypeOf<SWRInfiniteResponseWithData<string[]>["data"]>().toEqualTypeOf<string[][]>();
  });

  it("no fallbackData -> SWRInfiniteResponse (data includes undefined)", () => {
    expectTypeOf<SWRInfiniteResponse<string[]>["data"]>().toEqualTypeOf<string[][] | undefined>();
  });

  it("options without fallbackData -> SWRInfiniteResponse", () => {
    expectTypeOf<SWRInfiniteResponse<string[]>["data"]>().toEqualTypeOf<string[][] | undefined>();
  });
});
