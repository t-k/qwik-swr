import {
  FRESHNESS_PRESETS,
  type SWRConfig,
  type SWROptions,
  type ResolvedQueryConfig,
  type FreshnessPreset,
} from "../types/index.ts";

/** Hardcoded defaults when no config is provided. */
const DEFAULTS: ResolvedQueryConfig = {
  enabled: true,
  eagerness: "visible",
  staleTime: FRESHNESS_PRESETS.normal.staleTime,
  cacheTime: FRESHNESS_PRESETS.normal.cacheTime,
  dedupingInterval: FRESHNESS_PRESETS.normal.dedupingInterval,
  revalidateOn: ["focus", "reconnect"],
  refreshInterval: 0,
  retry: 3,
  retryInterval: 1000,
  timeout: 30_000,
  keepPreviousData: false,
};

function normalizeRetry(retry: boolean | number | undefined): number | undefined {
  if (retry === undefined) return undefined;
  if (retry === true) return 3;
  if (retry === false) return 0;
  return retry;
}

/** Common fields shared between SWRConfig and SWROptions */
const COMMON_FIELDS = [
  "staleTime",
  "cacheTime",
  "dedupingInterval",
  "revalidateOn",
  "refreshInterval",
  "eagerness",
  "timeout",
  "retryInterval",
] as const;

/** Apply defined fields from source to target */
function applyDefined(target: Record<string, any>, source: Record<string, any>): void {
  for (const field of COMMON_FIELDS) {
    if (source[field] !== undefined) {
      target[field] = source[field];
    }
  }
}

/**
 * Resolve options with priority: hook > provider > preset > hardcoded defaults.
 *
 * 1. Start with hardcoded defaults
 * 2. Apply freshness preset (from provider or hook)
 * 3. Apply provider config
 * 4. Apply hook options
 */
export function resolveOptions<Data = unknown>(
  providerConfig?: SWRConfig,
  hookOptions?: SWROptions<Data>,
): ResolvedQueryConfig<Data> {
  // Determine the effective freshness preset
  const freshness: FreshnessPreset =
    hookOptions?.freshness ?? providerConfig?.freshness ?? "normal";
  const preset = FRESHNESS_PRESETS[freshness];

  // Start with hardcoded defaults, then overlay preset
  const base = {
    ...DEFAULTS,
    staleTime: preset.staleTime,
    cacheTime: preset.cacheTime,
    dedupingInterval: preset.dedupingInterval,
  } as ResolvedQueryConfig<Data>;

  // Apply provider config (excluding freshness, already handled)
  if (providerConfig) {
    applyDefined(base, providerConfig);
    const providerRetry = normalizeRetry(providerConfig.retry);
    if (providerRetry !== undefined) base.retry = providerRetry;
  }

  // Apply hook options (highest priority, excluding freshness)
  if (hookOptions) {
    applyDefined(base, hookOptions);
    if (hookOptions.enabled !== undefined) base.enabled = hookOptions.enabled;
    if (hookOptions.fallbackData !== undefined) base.fallbackData = hookOptions.fallbackData;
    if (hookOptions.keepPreviousData !== undefined) base.keepPreviousData = hookOptions.keepPreviousData;
    if (hookOptions.onSuccess$) base.onSuccess$ = hookOptions.onSuccess$;
    if (hookOptions.onError$) base.onError$ = hookOptions.onError$;
    const hookRetry = normalizeRetry(hookOptions.retry);
    if (hookRetry !== undefined) base.retry = hookRetry;
  }

  // onErrorGlobal$ comes from provider config only (not hook-level)
  if (providerConfig?.onErrorGlobal$) {
    base.onErrorGlobal$ = providerConfig.onErrorGlobal$;
  }

  return base;
}
