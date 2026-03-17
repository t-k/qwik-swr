# useSWRInfinite の実装

## 概要

qwik-swr ライブラリにページネーション / 無限ローディング用の `useSWRInfinite` フックを追加した。
複数ラウンドのレビューを経て、useSWR との機能パリティを達成。

## 変更内容

### 新規ファイル

- `src/hooks/infinite-helpers.ts` - 純粋ヘルパー関数 (`resolvePageKeys`, `checkIsReachingEnd`, `fetchAllPages`, `fetchPageWithRetry`, `calculateRetryDelay`)
- `src/hooks/use-swr-infinite.ts` - メインのフック実装
- `tests/unit/swr-infinite.test.ts` - ユニットテスト (17件)
- `tests/integration/swr-infinite.test.ts` - 統合テスト (27件)

### 変更ファイル

- `src/types/index.ts` - `SWRInfiniteKeyLoader`, `SWRInfiniteOptions`, `SWRInfiniteResponse` 型を追加
- `src/cache/store.ts` - `registerCacheConfig()`, `startCooldown()`, `isCooldownActive()` パブリックAPI追加
- `src/index.ts` - 新しい型とフックのエクスポート追加
- `README.md` - API リファレンス、オプション表、使用例追加
- `CHANGELOG.md` - 0.3.0 エントリ追加
- `package.json` - バージョンを 0.2.1 -> 0.3.0 にバンプ

## レビュー対応ログ

### レビュー1: 初期設計
- Must Fix: setSize$負数バリデーション順序 -> 実は正しかったが NaN/Infinity ガード追加
- Should Fix: parallel, persistSize, revalidateFirstPage 未実装オプション -> 型から削除

### レビュー2: キャッシュ破壊 + 機能パリティ
- High: mutate$がカーソルキーを再計算 -> stable pageKeyHashes で修正
- Medium: retry/timeout/refreshInterval/onErrorGlobal$ 未実装 -> fetchPageWithRetry + timerCoordinator で対応

### レビュー3: コールバック + cacheTime
- Medium: setSize$/mutate$で onSuccess$/onError$/onErrorGlobal$ が呼ばれない -> executeFetch に集約
- Medium: cacheTime/dedupingInterval がGCで無効 -> registerCacheConfig + resolvedConfig 伝搬

### レビュー4: dedupingInterval
- Medium: フックローカルの dedup -> store の共有 cooldownMap に委譲

### レビュー5: cooldownMap クロスインスタンス
- Medium: lastFetchCompletedAt がフックローカル -> store.startCooldown/isCooldownActive で共有化、失敗時も cooldown

### レビュー6: 最終品質
- Must Fix: setSize$ で size 減少時の不要 refetch -> slice で trim、ネットワーク不要
- Should Fix: setSize$/mutate$ の AbortController が独立 -> abortCurrentFetch() で共有 generation
- Should Fix: mutate$ の revalidateAll: true ハードコード -> infiniteOpts.revalidateAll 参照
- Should Fix: doFetch 後の size 同期 -> executeFetch 前に移動

## 設計判断

### ヘルパー関数の分離
Qwik オプティマイザ非依存のテストを可能にするため、純粋ロジックを `infinite-helpers.ts` に分離。

### ページごとの個別キャッシュ
各ページは getKey が返すキーで個別にキャッシュ。既存 CacheStore をそのまま活用。

### fetchGeneration パターン
全フェッチ経路 (doFetch/setSize$/mutate$) で共有する generation カウンターで race condition を防止。

### stable pageKeyHashes
mutate$ ではフェッチ時に確定したキーハッシュを使い、楽観更新でカーソル値が変わってもキャッシュ破壊しない。

### 共有 cooldownMap
store のシングルトン cooldownMap を使い、同一リストの複数インスタンス間で dedup を共有。成功時も失敗時も cooldown を張る。

## テスト結果

- 全 52 テストファイル / 711 テスト合格
- ビルド成功 (型チェック含む)
- Lint 警告 0件

## dependabot PR 対応

- #11 @builder.io/qwik 1.19.2 -> マージ済み
- #12 vitest 4.1.0 -> マージ済み
- #9 oxlint 1.55.0 -> マージ済み
- #10 jsdom 29.0.0 -> マージ済み
- #13 vite 8.0.0 -> 保留 (qwik の peerDependency が `vite@">=5 <8"` のため互換性なし)
