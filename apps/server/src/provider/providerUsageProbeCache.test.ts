import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  USAGE_PROBE_FAILURE_TTL_MS,
  USAGE_PROBE_SUCCESS_TTL_MS,
  cachedUsageProbe,
  makeProviderUsageProbeCacheKey,
  makeUsageProbeCacheKey,
  readCachedUsageProbe,
  rememberUsageProbeResult,
  resetUsageProbeCacheForTests,
} from "./providerUsageProbeCache.ts";

const SUCCESS: ServerProviderUsageLimits = {
  source: "claudeStatusProbe",
  available: true,
  checkedAt: "2026-09-02T12:00:00.000Z",
  windows: [{ key: "five_hour", kind: "session", label: "Session", usedPercent: 12 }],
};

const FAILURE: ServerProviderUsageLimits = {
  source: "claudeStatusProbe",
  available: false,
  checkedAt: "2026-09-02T12:00:01.000Z",
  reason: "Could not read usage limits for this Claude account.",
  windows: [],
};

const API_KEY: ServerProviderUsageLimits = {
  source: "claudeStatusProbe",
  available: false,
  checkedAt: "2026-09-02T12:00:00.000Z",
  reason: "Usage limits unavailable for Claude API key accounts.",
  windows: [],
};

describe("usage probe cache", () => {
  it("scopes keys by driver, binary, home, and launch args", () => {
    expect(
      makeProviderUsageProbeCacheKey({
        driver: "claude",
        binaryPath: "claude",
        homePath: "  /custom  ",
      }),
    ).not.toBe(
      makeProviderUsageProbeCacheKey({
        driver: "claude",
        binaryPath: "claude",
      }),
    );
    expect(
      makeProviderUsageProbeCacheKey({
        driver: "cursor",
        binaryPath: "cursor",
        fallbackIdentity: "https://api.cursor.sh",
      }),
    ).not.toBe(
      makeProviderUsageProbeCacheKey({
        driver: "cursor",
        binaryPath: "cursor",
      }),
    );
  });

  it("reuses a successful snapshot for 180 seconds", () => {
    resetUsageProbeCacheForTests();
    const cacheKey = makeUsageProbeCacheKey({
      driver: "claude",
      binaryPath: "claude",
      homeIdentity: "success-ttl",
    });
    rememberUsageProbeResult(cacheKey, SUCCESS, 1_000);
    expect(readCachedUsageProbe(cacheKey, 1_000 + USAGE_PROBE_SUCCESS_TTL_MS - 1)).toEqual({
      skipProbe: true,
      limits: SUCCESS,
    });
    expect(readCachedUsageProbe(cacheKey, 1_000 + USAGE_PROBE_SUCCESS_TTL_MS)).toBeUndefined();
  });

  it("backs off a failed probe for 10 minutes without reverting live bars", () => {
    resetUsageProbeCacheForTests();
    const cacheKey = makeUsageProbeCacheKey({
      driver: "claude",
      binaryPath: "claude",
      homeIdentity: "failure-ttl",
    });
    rememberUsageProbeResult(cacheKey, FAILURE, 1_000);
    expect(readCachedUsageProbe(cacheKey, 1_000 + USAGE_PROBE_FAILURE_TTL_MS - 1)).toEqual({
      skipProbe: true,
      limits: undefined,
    });
    expect(readCachedUsageProbe(cacheKey, 1_000 + USAGE_PROBE_FAILURE_TTL_MS)).toBeUndefined();
  });

  it("treats API-key unavailability as a settled success", () => {
    resetUsageProbeCacheForTests();
    const cacheKey = makeUsageProbeCacheKey({
      driver: "claude",
      binaryPath: "claude",
      homeIdentity: "api-key",
    });
    rememberUsageProbeResult(cacheKey, API_KEY, 1_000);
    expect(readCachedUsageProbe(cacheKey, 1_000 + 1)?.limits).toEqual(API_KEY);
    expect(readCachedUsageProbe(cacheKey, 1_000 + USAGE_PROBE_SUCCESS_TTL_MS - 1)?.skipProbe).toBe(
      true,
    );
  });
});

describe("cachedUsageProbe", () => {
  it("does not spawn again while the success TTL holds", async () => {
    resetUsageProbeCacheForTests();
    const cacheKey = makeUsageProbeCacheKey({
      driver: "claude",
      binaryPath: "claude",
      homeIdentity: "cache-test",
    });
    let probes = 0;
    const probe = Effect.sync(() => {
      probes += 1;
      return SUCCESS;
    });

    expect(await Effect.runPromise(cachedUsageProbe({ cacheKey, probe }))).toEqual(SUCCESS);
    expect(await Effect.runPromise(cachedUsageProbe({ cacheKey, probe }))).toEqual(SUCCESS);
    expect(probes).toBe(1);
  });

  it("does not spawn again during the failure backoff", async () => {
    resetUsageProbeCacheForTests();
    const cacheKey = makeUsageProbeCacheKey({
      driver: "claude",
      binaryPath: "claude",
      homeIdentity: "failure-test",
    });
    let probes = 0;
    const probe = Effect.sync(() => {
      probes += 1;
      return FAILURE;
    });

    expect(await Effect.runPromise(cachedUsageProbe({ cacheKey, probe }))).toEqual(FAILURE);
    expect(await Effect.runPromise(cachedUsageProbe({ cacheKey, probe }))).toBeUndefined();
    expect(probes).toBe(1);
  });

  it("does not share snapshots across homes", () => {
    resetUsageProbeCacheForTests();
    const first = makeUsageProbeCacheKey({
      driver: "codex",
      binaryPath: "codex",
      homeIdentity: "home-a",
    });
    const second = makeUsageProbeCacheKey({
      driver: "codex",
      binaryPath: "codex",
      homeIdentity: "home-b",
    });
    rememberUsageProbeResult(first, SUCCESS, 5_000);
    expect(readCachedUsageProbe(second, 5_000)).toBeUndefined();
    expect(readCachedUsageProbe(first, 5_000)?.limits).toEqual(SUCCESS);
  });
});
