# Changelog

## [0.3.2] - 2026-03-17

### Fixed

- **Production build crash** -- Qwik optimizer crashes with "Cannot read properties of null (reading '0')" when processing `useSWRInfinite`. Nested function declarations (`executeFetch`, `abortCurrentFetch`) inside the hook body were captured by `$()` closures, which the optimizer cannot serialize across QRL boundaries. Extracted to module-level functions with context parameter. Dev mode was unaffected. ([#details](#qwik-optimizer-crash-details))

### Added

- `SWRResponseWithData<Data>` type -- when `fallbackData` is provided, `useSWR` returns `data: Data` instead of `data: Data | undefined`, eliminating unnecessary null checks
- `SWRInfiniteResponseWithData<Data>` type -- same narrowing for `useSWRInfinite` with `fallbackData`
- Build output compatibility test (`tests/build/optimizer-compat.test.ts`) -- automatically detects function declarations nested inside hook bodies that would crash the Qwik optimizer in consumer production builds
- `test:build` and `test:all` npm scripts for build output verification

### Notes

#### Qwik optimizer crash details

The `$()` function in Qwik creates a QRL boundary. All values captured by the closure must be serializable. Regular function declarations are not serializable, so capturing them from `$()` closures crashes the optimizer during production builds (the QRL extraction phase). This only manifests in production because dev mode skips QRL extraction.

**Rule**: Never capture nested function declarations from `$()` closures. Instead, extract them to module-level functions and pass state via a context object. See `src/hooks/create-mutations.ts` (`MutationContext` + `performMutate`) for the canonical pattern.

## [0.3.1] - 2026-03-17

### Added

- `fallbackData` option for `useSWRInfinite` -- pre-load pages from SSR (e.g. `routeLoader$`)
  - `state.data` is initialized immediately (no loading spinner)
  - `initialSize` defaults to `fallbackData.length` when not explicitly set
  - Each page is seeded into individual cache entries with cacheTime registration
  - Background revalidation still runs (stale-while-revalidate)

### Fixed

- `setSize$` with decreased size now trims data in-place without network request
- `setSize$` / `mutate$` now share abort generation with lifecycle fetch (prevents stale overwrites)
- `mutate$` revalidation respects `revalidateAll` option instead of hardcoded `true`
- `doFetch` updates `_internal.currentSize` before `executeFetch` (correct on error)
- `onSuccess$` / `onError$` / `onErrorGlobal$` now fire on all fetch paths (setSize$, mutate$)
- `cacheTime` registered per page key via `store.registerCacheConfig()` for proper GC
- `dedupingInterval` uses store's shared `cooldownMap` for cross-instance dedup
  - Cooldown starts on both success and error (matches `useSWR` behavior)
- Removed unimplemented options from type: `parallel`, `persistSize`, `revalidateFirstPage`

## [0.3.0] - 2026-03-17

### Added

- `useSWRInfinite` hook for infinite loading / paginated data fetching
  - Sequential page fetching with cursor-based and offset-based pagination support
  - Individual page caching (each page cached by its own key)
  - `setSize$` for controlling the number of loaded pages
  - `mutate$` for optimistic updates across all pages (stable key refs prevent cursor corruption)
  - `isReachingEnd` detection (getKey returns null)
  - `isLoadingMore` / `isRefreshing` status flags
  - Per-page retry with exponential backoff and per-attempt timeout
  - Event-based revalidation (focus/reconnect) and refreshInterval via timerCoordinator
  - `revalidateAll` option to refetch all pages on revalidation
  - `dedupingInterval` via store's shared cooldownMap (cross-instance dedup, error cooldown)
  - `cacheTime` registered per page key for proper GC awareness
  - `onSuccess$` / `onError$` / `onErrorGlobal$` callbacks on all fetch paths (doFetch, setSize$, mutate$)
- New types: `SWRInfiniteKeyLoader`, `SWRInfiniteOptions`, `SWRInfiniteResponse`
- `store.startCooldown()` / `store.isCooldownActive()` public API for external cooldown management
- `store.registerCacheConfig()` public API for external cacheTime/GC registration

### Removed

- `parallel`, `persistSize`, `revalidateFirstPage` options from `SWRInfiniteOptions` (were declared but unimplemented)

## [0.2.1] - 2026-03-12

### Fixed

- `types` paths in `package.json` for `.` and `./subscription` exports now point to correct `lib-types/src/` locations (fixes TS7016)

### Chores

- Add Dependabot configuration for npm and github-actions ecosystems

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
