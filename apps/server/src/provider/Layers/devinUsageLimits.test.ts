import { describe, expect, it } from "@effect/vitest";

import { devinQuotaToUsageLimits } from "./devinUsageLimits.ts";

const checkedAt = "2026-09-12T10:00:00.000Z";

describe("devinQuotaToUsageLimits", () => {
  it("maps the hub's daily and weekly quota onto usage windows", () => {
    // Percentages arrive already flipped to "used"; Devin's own API reports
    // "remaining".
    const limits = devinQuotaToUsageLimits({
      checkedAt,
      quota: {
        plan: "Free",
        usage: {
          daily: { percent: 1, resets_at: "2026-09-13T08:00:00Z", period_hours: 24 },
          weekly: { percent: 6, resets_at: "2026-09-13T08:00:00Z", period_hours: 168 },
        },
      },
    });
    expect(limits?.windows).toEqual([
      {
        id: "daily",
        kind: "other",
        label: "Daily",
        usedPercent: 1,
        resetsAt: "2026-09-13T08:00:00Z",
        windowDurationMins: 1440,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 6,
        resetsAt: "2026-09-13T08:00:00Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("keeps the weekly row when a Max plan reports no daily quota", () => {
    const limits = devinQuotaToUsageLimits({
      checkedAt,
      quota: { usage: { weekly: { percent: 12, period_hours: 168 } } },
    });
    expect(limits?.windows.map((window) => window.id)).toEqual(["weekly"]);
  });

  it("clamps out-of-range percentages the contract would reject", () => {
    const limits = devinQuotaToUsageLimits({
      checkedAt,
      quota: { usage: { daily: { percent: 143.7 }, weekly: { percent: -4 } } },
    });
    expect(limits?.windows.map((window) => window.usedPercent)).toEqual([100, 0]);
  });

  it("omits a reset time rather than inventing one", () => {
    const limits = devinQuotaToUsageLimits({
      checkedAt,
      quota: { usage: { daily: { percent: 5 } } },
    });
    expect(limits?.windows[0]).not.toHaveProperty("resetsAt");
    expect(limits?.windows[0]).not.toHaveProperty("windowDurationMins");
  });

  it("reports nothing usable rather than empty bars", () => {
    // The caller drops the account entirely on undefined.
    expect(devinQuotaToUsageLimits({ checkedAt, quota: { usage: {} } })).toBeUndefined();
    expect(
      devinQuotaToUsageLimits({
        checkedAt,
        quota: { usage: { daily: { percent: Number.NaN } } },
      }),
    ).toBeUndefined();
  });
});
