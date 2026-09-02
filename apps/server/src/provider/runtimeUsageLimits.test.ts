import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { parseRuntimeUsageLimitsUpdate } from "./runtimeUsageLimits.ts";

const CHECKED_AT = "2026-08-09T00:00:00.000Z";
const RESETS_AT_SECONDS = 1786752000;
const RESETS_AT_ISO = "2026-08-15T00:00:00.000Z";

const claudeDriver = ProviderDriverKind.make("claudeAgent");
const legacyClaudeDriver = ProviderDriverKind.make("claude");
const codexDriver = ProviderDriverKind.make("codex");
const grokDriver = ProviderDriverKind.make("grok");

const claudeFiveHourEvent = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    rateLimitType: "five_hour",
    utilization: 0.42,
    resetsAt: RESETS_AT_SECONDS,
  },
} as const;

const claudeFiveHourWindows = {
  source: "claudeStatusProbe",
  windows: [
    {
      key: "five_hour",
      label: "Session",
      usedPercent: 42,
      windowDurationMins: 300,
      resetsAt: RESETS_AT_ISO,
    },
  ],
} as const;

describe("parseRuntimeUsageLimitsUpdate", () => {
  it("maps a Claude five-hour rate limit event onto the session window", () => {
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: claudeDriver,
        checkedAt: CHECKED_AT,
        rateLimits: claudeFiveHourEvent,
      }),
    ).toEqual(claudeFiveHourWindows);
  });

  it("accepts the legacy claude driver kind as well as claudeAgent", () => {
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: legacyClaudeDriver,
        checkedAt: CHECKED_AT,
        rateLimits: claudeFiveHourEvent,
      }),
    ).toEqual(claudeFiveHourWindows);
  });

  it("maps a Claude model-scoped weekly onto its own labeled window", () => {
    const update = parseRuntimeUsageLimitsUpdate({
      driverKind: claudeDriver,
      checkedAt: CHECKED_AT,
      rateLimits: {
        rate_limit_info: {
          rateLimitType: "weekly_scoped",
          utilization: 0.95,
          resetsAt: RESETS_AT_SECONDS,
          scope: { model: { display_name: "Fable" } },
        },
      },
    });

    expect(update?.windows).toEqual([
      {
        key: "weekly_scoped:Fable",
        label: "Fable",
        usedPercent: 95,
        windowDurationMins: 10080,
        resetsAt: RESETS_AT_ISO,
      },
    ]);
  });

  it("maps a Claude seven-day rate limit event onto the weekly window", () => {
    const update = parseRuntimeUsageLimitsUpdate({
      driverKind: claudeDriver,
      checkedAt: CHECKED_AT,
      rateLimits: {
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.88,
          resetsAt: RESETS_AT_SECONDS,
        },
      },
    });

    expect(update?.windows).toEqual([
      {
        key: "seven_day",
        label: "Weekly",
        usedPercent: 88,
        windowDurationMins: 10080,
        resetsAt: RESETS_AT_ISO,
      },
    ]);
  });

  it("reads Claude snake_case reset fields and ISO reset strings", () => {
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: claudeDriver,
        checkedAt: CHECKED_AT,
        rateLimits: {
          rate_limit_info: {
            rate_limit_type: "seven_day",
            utilization: 0.27,
            resets_at: RESETS_AT_ISO,
          },
        },
      })?.windows,
    ).toEqual([
      {
        key: "seven_day",
        label: "Weekly",
        usedPercent: 27,
        windowDurationMins: 10080,
        resetsAt: RESETS_AT_ISO,
      },
    ]);
  });

  it("scales Claude utilization from a 0–1 fraction onto usedPercent", () => {
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: claudeDriver,
        checkedAt: CHECKED_AT,
        rateLimits: {
          rate_limit_info: { rateLimitType: "five_hour", utilization: 0.85 },
        },
      })?.windows[0]?.usedPercent,
    ).toBe(85);
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: claudeDriver,
        checkedAt: CHECKED_AT,
        rateLimits: {
          rate_limit_info: { rateLimitType: "five_hour", utilization: 1 },
        },
      })?.windows[0]?.usedPercent,
    ).toBe(100);
  });

  it("leaves Claude usedPercent and already-percent utilization unscaled", () => {
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: claudeDriver,
        checkedAt: CHECKED_AT,
        rateLimits: {
          rate_limit_info: { rateLimitType: "five_hour", usedPercent: 42 },
        },
      })?.windows[0]?.usedPercent,
    ).toBe(42);
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: claudeDriver,
        checkedAt: CHECKED_AT,
        rateLimits: {
          rate_limit_info: { rateLimitType: "five_hour", utilization: 42 },
        },
      })?.windows[0]?.usedPercent,
    ).toBe(42);
  });

  it("maps Claude model-family weeklies onto their own bars and ignores overage", () => {
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: claudeDriver,
        checkedAt: CHECKED_AT,
        rateLimits: { rate_limit_info: { rateLimitType: "seven_day_opus", utilization: 0.1 } },
      })?.windows,
    ).toEqual([
      { key: "seven_day_opus", label: "Opus", usedPercent: 10, windowDurationMins: 10080 },
    ]);
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: claudeDriver,
        checkedAt: CHECKED_AT,
        rateLimits: { rate_limit_info: { rateLimitType: "seven_day_sonnet", utilization: 0.1 } },
      })?.windows,
    ).toEqual([
      { key: "seven_day_sonnet", label: "Sonnet", usedPercent: 10, windowDurationMins: 10080 },
    ]);
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: claudeDriver,
        checkedAt: CHECKED_AT,
        rateLimits: { rate_limit_info: { rateLimitType: "overage", utilization: 0.1 } },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when a Claude event carries no utilization", () => {
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: claudeDriver,
        checkedAt: CHECKED_AT,
        rateLimits: { rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } },
      }),
    ).toBeUndefined();
  });

  it("ignores out-of-range Claude reset timestamps instead of throwing", () => {
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: claudeDriver,
        checkedAt: CHECKED_AT,
        rateLimits: {
          rate_limit_info: {
            rateLimitType: "five_hour",
            utilization: 0.4,
            resetsAt: Number.MAX_VALUE,
          },
        },
      })?.windows,
    ).toEqual([{ key: "five_hour", label: "Session", usedPercent: 40, windowDurationMins: 300 }]);
  });

  it("reads a Codex rolling notification from its rateLimits envelope", () => {
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: codexDriver,
        checkedAt: CHECKED_AT,
        rateLimits: {
          rateLimits: {
            secondary: {
              usedPercent: 61,
              resetsAt: RESETS_AT_SECONDS,
              windowDurationMins: 10080,
            },
          },
        },
      }),
    ).toEqual({
      source: "codexAppServer",
      windows: [
        {
          key: "duration:10080",
          label: "Weekly",
          usedPercent: 61,
          windowDurationMins: 10080,
          resetsAt: RESETS_AT_ISO,
        },
      ],
    });
  });

  it("returns undefined for drivers without runtime rate-limit telemetry", () => {
    expect(
      parseRuntimeUsageLimitsUpdate({
        driverKind: grokDriver,
        checkedAt: CHECKED_AT,
        rateLimits: { rate_limit_info: { rateLimitType: "five_hour", utilization: 10 } },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for unusable payloads", () => {
    for (const rateLimits of [undefined, null, "nope", {}, []]) {
      expect(
        parseRuntimeUsageLimitsUpdate({
          driverKind: claudeDriver,
          checkedAt: CHECKED_AT,
          rateLimits,
        }),
      ).toBeUndefined();
    }
  });
});
