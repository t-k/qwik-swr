/**
 * Type-level tests: verify that fallbackData narrows SWRResponse.data
 * from `Data | undefined` to `Data`.
 *
 * These tests use TypeScript's type system at compile time.
 * Runtime assertions are minimal — the goal is to catch type regressions.
 */
import { describe, it, expectTypeOf } from "vitest";
import type { QRL } from "@builder.io/qwik";
import type {
  SWRResponse,
  SWRResponseWithData,
  SWRInfiniteResponse,
  SWRInfiniteResponseWithData,
} from "../../src/types/index.ts";

// We can't call hooks outside Qwik, so test the types directly
// by simulating what the overloads return.

describe("SWRResponseWithData type", () => {
  it("data is Data (not Data | undefined)", () => {
    type R = SWRResponseWithData<string[]>;
    expectTypeOf<R["data"]>().toEqualTypeOf<string[]>();
  });

  it("data does not include undefined", () => {
    type R = SWRResponseWithData<string[]>;
    expectTypeOf<R["data"]>().not.toEqualTypeOf<string[] | undefined>();
  });

  it("mutate$ updater current is Data (not Data | undefined)", () => {
    type R = SWRResponseWithData<number[]>;
    // Extract the mutate$ parameter type
    type MutateFn = R["mutate$"] extends QRL<infer F> ? F : never;
    // The first argument can be Data or updater function
    type FirstArg = Parameters<MutateFn>[0];
    // When it's a function, current should be Data
    type UpdaterFn = Extract<FirstArg, Function>;
    type UpdaterParams = Parameters<UpdaterFn>;
    expectTypeOf<UpdaterParams[0]>().toEqualTypeOf<number[]>();
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

  it("mutate$ updater current is Data[] (not Data[] | undefined)", () => {
    type R = SWRInfiniteResponseWithData<number>;
    type MutateFn = R["mutate$"] extends QRL<infer F> ? F : never;
    type FirstArg = Parameters<MutateFn>[0];
    // FirstArg is optional: Data[] | updater | undefined
    // When it's a function, current should be Data[]
    type UpdaterFn = Extract<NonNullable<FirstArg>, Function>;
    type UpdaterParams = Parameters<UpdaterFn>;
    expectTypeOf<UpdaterParams[0]>().toEqualTypeOf<number[]>();
  });
});

describe("SWRInfiniteResponse type (no fallbackData)", () => {
  it("data includes undefined", () => {
    type R = SWRInfiniteResponse<string>;
    expectTypeOf<R["data"]>().toEqualTypeOf<string[] | undefined>();
  });
});
