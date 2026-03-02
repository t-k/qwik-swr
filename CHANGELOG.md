# Changelog

## [0.2.0] - 2026-03-02

### Added

- `Signal<SWRKey>` reactive key support for `useSWR` and `useSubscription`
  - Automatically cleans up and re-fetches/reconnects when the Signal value changes
  - Uses `useVisibleTask$` `track()` to integrate with Qwik's resumability model
- `keepPreviousData` option in `SWROptions`
  - Retains previous key's data during key transition until new data arrives
  - Resets data on disabled key transition (null/undefined/false)
- `MaybeSignalSWRKey` type export
- `isDisabledKey()` utility (`src/utils/resolve-key.ts`)
- `startFetchLifecycle()` + `ActiveLifecycle` interface (`src/hooks/lifecycle-state.ts`)
  - Imperative teardown support for lifecycle management

### Changed

- `MutationContext.key` replaced with `keyRef: { current }` for reactive key reference
- `setupFetchLifecycle` refactored to delegate to `startFetchLifecycle`

## [0.1.0] - 2026-02-03

### Added

- `useSWR` hook (stale-while-revalidate data fetching)
- `useMutation` hook (optimistic updates + cache invalidation)
- `useSubscription` hook (WebSocket/SSE real-time subscriptions)
- `SWRProvider` for global configuration
- Freshness presets (volatile / eager / fast / normal / slow / static)
- Request deduplication (in-flight + cooldown dedup)
- Auto revalidation (focus / reconnect / interval)
- Retry with exponential backoff
- SSR integration (`fallbackData`)
- Cache API (read / mutate / delete / prefetch / export / import)
- Cross-tab sync (BroadcastChannel)
- Notification batching + storage write batching
- Lazy hydration
- Timer coordination
- Memory-aware GC (maxEntries + deviceMemory)
- Subscription cross-tab sync + leader election dedup
- Storage plugins (memory / localStorage / IndexedDB / hybrid / batched)
