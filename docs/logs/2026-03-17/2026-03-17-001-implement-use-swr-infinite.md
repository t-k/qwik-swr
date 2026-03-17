# useSWRInfinite の実装

## 概要

qwik-swr ライブラリにページネーション / 無限ローディング用の `useSWRInfinite` フックを追加した。

## 変更内容

### 新規ファイル

- `src/types/index.ts` - `SWRInfiniteKeyLoader`, `SWRInfiniteOptions`, `SWRInfiniteResponse` 型を追加
- `src/hooks/infinite-helpers.ts` - 純粋ヘルパー関数 (`resolvePageKeys`, `checkIsReachingEnd`, `fetchAllPages`)
- `src/hooks/use-swr-infinite.ts` - メインのフック実装
- `tests/unit/swr-infinite.test.ts` - ユニットテスト (11件)
- `tests/integration/swr-infinite.test.ts` - 統合テスト (13件)

### 変更ファイル

- `src/index.ts` - 新しい型とフックのエクスポート追加
- `README.md` - API リファレンス、オプション表、使用例 (カーソルベース + オフセットベース) 追加
- `CHANGELOG.md` - 0.3.0 エントリ追加
- `package.json` - バージョンを 0.2.1 -> 0.3.0 にバンプ

## 設計判断

### ヘルパー関数の分離

Qwik の `component$` / `$()` はオプティマイザを必要とするため、`swr-provider.tsx` をインポートチェーンに含むファイルはテストで直接インポートできない。そのため、純粋なロジック (`resolvePageKeys`, `checkIsReachingEnd`, `fetchAllPages`) を `infinite-helpers.ts` に分離し、テスト可能にした。

### ページごとの個別キャッシュ

各ページは `getKey` が返すキーで個別にキャッシュされる。これにより:
- 個別ページの再検証が可能
- 既存の `CacheStore` シングルトンをそのまま活用
- `useSWR` のキャッシュと共存可能

### fetchGeneration パターン

複数の同時フェッチ (setSize 連打など) を安全に処理するため、`fetchGeneration` カウンターで最新のフェッチのみが状態を更新するようにした。

## テスト結果

- 全 52 テストファイル / 690 テスト合格
- ビルド成功 (型チェック含む)
- Lint 警告 0件
