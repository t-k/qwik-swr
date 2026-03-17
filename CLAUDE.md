# qwik-swr Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-02-03

コミットメッセージは英語で

## Active Technologies

- TypeScript 5.x (Qwik framework) + @builder.io/qwik (QRL, Signal, useSignal, useVisibleTask$, $, component$) (002-phase2-advanced-features)
- インメモリ CacheStore (既存) + localStorage / IndexedDB プラグイン (Phase 3) (002-phase2-advanced-features)
- TypeScript 5.x (Qwik framework) + @builder.io/qwik >=1.5.0 (peerDependency), Playwright (E2E テスト用に新規追加) (003-fix-subscription-hooks-test)
- N/A (既存の CacheStore を使用、変更なし) (003-fix-subscription-hooks-test)
- TypeScript 5.x（Qwikフレームワーク） + `@builder.io/qwik` ^1.0.0 || ^2.0.0（peerDependency）、追加外部依存なし (006-cross-tab-perf-optimizations)
- インメモリCacheStore + IndexedDB / localStorage プラグイン（既存） (006-cross-tab-perf-optimizations)

- TypeScript 5.x + `@builder.io/qwik` ^1.0.0 || ^2.0.0 (peerDependency), `@builder.io/qwik-city` ^1.0.0 || ^2.0.0 (peerDependency) (001-qwik-swr-package)

## Project Structure

```text
src/           # core library (hooks, cache, types, init, provider, utils)
storage/       # CacheStorage plugins (memory, localStorage, IndexedDB, hybrid, batched)
tests/         # unit + integration tests
```

## Commands

npm test && npm run lint

## Code Style

TypeScript 5.x: Follow standard conventions

## Recent Changes

- 006-cross-tab-perf-optimizations: Cross-tab sync (BroadcastChannel), notification/storage batching, lazy hydration, memory-aware GC (maxEntries + deviceMemory), timer coordination, cross-tab fetch dedup
- 005-qrl-error-handling-cleanup: QRL resolve caching, error handling improvements, type safety cleanup, fake-indexeddb
- 003-fix-subscription-hooks-test: Added TypeScript 5.x (Qwik framework) + @builder.io/qwik >=1.5.0 (peerDependency), Playwright (E2E テスト用に新規追加)

<!-- MANUAL ADDITIONS START -->

## Qwik $() Closure Rules (CRITICAL)

`$()` はQRL境界を作る。クロージャ内でキャプチャされる値は全てシリアライズ可能でなければならない。

**禁止**: hook関数内のネスト関数宣言を `$()` クロージャからキャプチャすること。
production buildでQwik optimizerがクラッシュする（dev modeでは発覚しない）。

```ts
// NG: ネスト関数を $() からキャプチャ
function useFoo() {
  function helper() { ... }        // hook内のネスト関数
  const action$ = $(() => {
    helper();                       // optimizer crash in production
  });
}

// OK: モジュールレベル関数 + コンテキスト渡し
function helper(ctx: FooContext) { ... }  // モジュールレベル
function useFoo() {
  const ctx = { state, _internal };
  const action$ = $(() => {
    helper(ctx);                    // シリアライズ可能な値のみキャプチャ
  });
}
```

パターン参考: `src/hooks/create-mutations.ts` の `MutationContext` + `performMutate`

CI検証: `tests/build/optimizer-compat.test.ts` がビルド出力を構造解析し、hook内のネスト関数を自動検出する。

<!-- MANUAL ADDITIONS END -->
