import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { isAuthoritativeUsageUnavailable } from "./providerUsageLimits.ts";

/**
 * Community floor for Claude `/api/oauth/usage` (and the PTY `/usage` scrape
 * that hits it). Success reuses the last snapshot; any failed spawn — 429,
 * missing binary, timeout, old CLI — backs off for 10 minutes instead of
 * retrying on the next provider health tick.
 */
export const USAGE_PROBE_SUCCESS_TTL_MS = 180_000;
export const USAGE_PROBE_FAILURE_TTL_MS = 10 * 60_000;

type UsageProbeCacheOutcome =
  | { readonly _tag: "Success"; readonly limits: ServerProviderUsageLimits }
  | { readonly _tag: "Failure" };

interface UsageProbeCacheEntry {
  readonly expiresAtMs: number;
  readonly outcome: UsageProbeCacheOutcome;
}

interface UsageProbeCacheRead {
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly skipProbe: boolean;
}

const cache = new Map<string, UsageProbeCacheEntry>();

export function makeProviderUsageProbeCacheKey(input: {
  readonly driver: string;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly fallbackIdentity?: string;
}): string {
  const homePath = input.homePath?.trim() ?? "";
  const fallback = input.fallbackIdentity?.trim() ?? "";
  return JSON.stringify([
    input.driver,
    input.binaryPath,
    homePath.length > 0 ? homePath : fallback.length > 0 ? fallback : "default",
    input.launchArgs ?? null,
  ]);
}

export function resetUsageProbeCacheForTests(): void {
  cache.clear();
}

function outcomeFromLimits(limits: ServerProviderUsageLimits): UsageProbeCacheOutcome {
  if (limits.available || isAuthoritativeUsageUnavailable(limits)) {
    return { _tag: "Success", limits };
  }
  return { _tag: "Failure" };
}

export function readCachedUsageProbe(
  cacheKey: string,
  nowMs: number,
): UsageProbeCacheRead | undefined {
  const entry = cache.get(cacheKey);
  if (entry === undefined || nowMs >= entry.expiresAtMs) return undefined;
  if (entry.outcome._tag === "Success") {
    return { skipProbe: true, limits: entry.outcome.limits };
  }
  // Failure backoff: do not spawn. Leave `limits` unset so a live-patched
  // snapshot is not reverted to the last probe. The merge path keeps published
  // bars when the refresh omits usageLimits.
  return { skipProbe: true, limits: undefined };
}

export function rememberUsageProbeResult(
  cacheKey: string,
  limits: ServerProviderUsageLimits,
  nowMs: number,
): ServerProviderUsageLimits {
  const outcome = outcomeFromLimits(limits);
  const ttlMs =
    outcome._tag === "Success" ? USAGE_PROBE_SUCCESS_TTL_MS : USAGE_PROBE_FAILURE_TTL_MS;
  cache.set(cacheKey, { expiresAtMs: nowMs + ttlMs, outcome });
  return limits;
}

/**
 * Skip a usage CLI/RPC when a fresh success or a failure backoff is in cache.
 * `undefined` means omit usageLimits on this refresh so last-good / live bars stay.
 */
export const cachedUsageProbe = Effect.fn("cachedUsageProbe")(function* (input: {
  readonly cacheKey: string;
  readonly probe: Effect.Effect<ServerProviderUsageLimits>;
}): Effect.fn.Return<ServerProviderUsageLimits | undefined> {
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const cached = readCachedUsageProbe(input.cacheKey, nowMs);
  if (cached?.skipProbe) {
    return cached.limits;
  }
  return rememberUsageProbeResult(input.cacheKey, yield* input.probe, nowMs);
});
