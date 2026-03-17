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
import type { QRL, Signal } from "@builder.io/qwik";
import type {
  SWRKey,
  ValidKey,
  Fetcher,
  SWROptions,
  SWRResponse,
  SWRResponseWithData,
  SWRInfiniteOptions,
  SWRInfiniteResponse,
  SWRInfiniteResponseWithData,
  SWRInfiniteKeyLoader,
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
// We define overloaded interfaces that mirror the hook signatures,
// then use `expectTypeOf` on the return type of specific call
// signatures. This verifies overload ordering without needing
// Qwik runtime — TypeScript resolves overloads at compile time.
// ═══════════════════════════════════════════════════════════════

// Mirror useSWR overloads as a callable interface
interface UseSWR {
  // 1a: valid key + fallbackData
  <Data, K extends ValidKey>(
    key: K,
    fetcher: QRL<Fetcher<Data, K>>,
    options: SWROptions<Data> & { fallbackData: Data },
  ): SWRResponseWithData<Data>;
  // 1b: valid key
  <Data, K extends ValidKey>(
    key: K,
    fetcher: QRL<Fetcher<Data, K>>,
    options?: SWROptions<Data>,
  ): SWRResponse<Data>;
  // 2: disabled key
  <Data>(
    key: null | undefined | false,
    fetcher: QRL<Fetcher<Data, any>>,
    options?: SWROptions<Data>,
  ): SWRResponse<Data>;
  // 3a: runtime key + fallbackData
  <Data, K extends ValidKey>(
    key: SWRKey,
    fetcher: QRL<Fetcher<Data, K>>,
    options: SWROptions<Data> & { fallbackData: Data },
  ): SWRResponseWithData<Data>;
  // 3b: runtime key
  <Data, K extends ValidKey>(
    key: SWRKey,
    fetcher: QRL<Fetcher<Data, K>>,
    options?: SWROptions<Data>,
  ): SWRResponse<Data>;
  // 4a: Signal key + fallbackData
  <Data, K extends ValidKey>(
    key: Signal<SWRKey>,
    fetcher: QRL<Fetcher<Data, K>>,
    options: SWROptions<Data> & { fallbackData: Data },
  ): SWRResponseWithData<Data>;
  // 4b: Signal key
  <Data, K extends ValidKey>(
    key: Signal<SWRKey>,
    fetcher: QRL<Fetcher<Data, K>>,
    options?: SWROptions<Data>,
  ): SWRResponse<Data>;
}

// Mirror useSWRInfinite overloads
interface UseSWRInfinite {
  <Data, K extends ValidKey>(
    getKey: QRL<SWRInfiniteKeyLoader<Data, K>>,
    fetcher: QRL<Fetcher<Data, K>>,
    options: SWRInfiniteOptions<Data> & { fallbackData: Data[] },
  ): SWRInfiniteResponseWithData<Data>;
  <Data, K extends ValidKey>(
    getKey: QRL<SWRInfiniteKeyLoader<Data, K>>,
    fetcher: QRL<Fetcher<Data, K>>,
    options?: SWRInfiniteOptions<Data>,
  ): SWRInfiniteResponse<Data>;
}

// Helper: extract the return type for a specific call pattern
type CallResult<
  F extends (...args: any[]) => any,
  Args extends Parameters<F>,
> = F extends (...args: Args) => infer R ? R : never;

describe("useSWR overload resolution", () => {
  // Type-level fixtures
  type F = QRL<Fetcher<string[], string>>;
  type Sig = Signal<SWRKey>;

  it("valid key + fallbackData -> SWRResponseWithData", () => {
    type Result = CallResult<UseSWR, [string, F, SWROptions<string[]> & { fallbackData: string[] }]>;
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[]>();
  });

  it("valid key + no fallbackData -> SWRResponse (data includes undefined)", () => {
    type Result = CallResult<UseSWR, [string, F]>;
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[] | undefined>();
  });

  it("valid key + options without fallbackData -> SWRResponse", () => {
    type Result = CallResult<UseSWR, [string, F, SWROptions<string[]>]>;
    // Without fallbackData in the intersection, this should resolve to SWRResponse
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[] | undefined>();
  });

  it("disabled key -> SWRResponse (always includes undefined)", () => {
    type Result = CallResult<UseSWR, [null, QRL<Fetcher<string[], any>>]>;
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[] | undefined>();
  });

  it("runtime SWRKey + fallbackData -> SWRResponseWithData", () => {
    type Result = CallResult<UseSWR, [SWRKey, F, SWROptions<string[]> & { fallbackData: string[] }]>;
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[]>();
  });

  it("runtime SWRKey + no fallbackData -> SWRResponse", () => {
    type Result = CallResult<UseSWR, [SWRKey, F]>;
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[] | undefined>();
  });

  it("Signal key + fallbackData -> SWRResponseWithData", () => {
    type Result = CallResult<UseSWR, [Sig, F, SWROptions<string[]> & { fallbackData: string[] }]>;
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[]>();
  });

  it("Signal key + no fallbackData -> SWRResponse", () => {
    type Result = CallResult<UseSWR, [Sig, F]>;
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[] | undefined>();
  });
});

describe("useSWRInfinite overload resolution", () => {
  type F = QRL<Fetcher<string[], string>>;
  type GK = QRL<SWRInfiniteKeyLoader<string[], string>>;

  it("fallbackData -> SWRInfiniteResponseWithData", () => {
    type Result = CallResult<UseSWRInfinite, [GK, F, SWRInfiniteOptions<string[]> & { fallbackData: string[][] }]>;
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[][]>();
  });

  it("no fallbackData -> SWRInfiniteResponse (data includes undefined)", () => {
    type Result = CallResult<UseSWRInfinite, [GK, F]>;
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[][] | undefined>();
  });

  it("options without fallbackData -> SWRInfiniteResponse", () => {
    type Result = CallResult<UseSWRInfinite, [GK, F, SWRInfiniteOptions<string[]>]>;
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[][] | undefined>();
  });
});
