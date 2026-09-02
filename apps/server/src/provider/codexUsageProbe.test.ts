import { describe, expect, it } from "vite-plus/test";

import { resolveCodexRateLimitSnapshotUsageLimits } from "./codexUsageProbe.ts";

const CHECKED_AT = "2026-06-20T00:00:00.000Z";
const PRIMARY_RESETS_AT_SECONDS = 1776448800;
const PRIMARY_RESETS_AT_ISO = "2026-04-17T18:00:00.000Z";

describe("resolveCodexRateLimitSnapshotUsageLimits", () => {
  it("builds session and weekly windows from a full snapshot", () => {
    const usage = resolveCodexRateLimitSnapshotUsageLimits({
      checkedAt: CHECKED_AT,
      snapshot: {
        planType: "plus",
        primary: {
          usedPercent: 25,
          resetsAt: PRIMARY_RESETS_AT_SECONDS,
          windowDurationMins: 300,
        },
        secondary: {
          usedPercent: 50,
          resetsAt: PRIMARY_RESETS_AT_SECONDS,
          windowDurationMins: 10080,
        },
      },
    });

    expect(usage).toEqual({
      source: "codexAppServer",
      available: true,
      checkedAt: CHECKED_AT,
      windows: [
        {
          key: "duration:300",
          kind: "session",
          label: "Session",
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: PRIMARY_RESETS_AT_ISO,
        },
        {
          key: "duration:10080",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 50,
          windowDurationMins: 10080,
          resetsAt: PRIMARY_RESETS_AT_ISO,
        },
      ],
    });
  });

  it.each(["free", "go"] as const)(
    "keeps the %s plan's reported durations instead of rewriting them as monthly",
    (planType) => {
      const usage = resolveCodexRateLimitSnapshotUsageLimits({
        checkedAt: CHECKED_AT,
        snapshot: {
          planType,
          primary: {
            usedPercent: 25,
            resetsAt: PRIMARY_RESETS_AT_SECONDS,
            windowDurationMins: 10080,
          },
          secondary: { usedPercent: 50, windowDurationMins: 300 },
        },
      });

      expect(
        usage.windows.map(({ kind, label, windowDurationMins }) => ({
          kind,
          label,
          windowDurationMins,
        })),
      ).toEqual([
        { kind: "session", label: "Session", windowDurationMins: 300 },
        { kind: "weekly", label: "Weekly", windowDurationMins: 10080 },
      ]);
    },
  );

  it("uses neutral labels when durations are omitted instead of guessing 5h vs weekly", () => {
    const usage = resolveCodexRateLimitSnapshotUsageLimits({
      checkedAt: CHECKED_AT,
      snapshot: {
        primary: { usedPercent: 25 },
        secondary: { usedPercent: 50 },
      },
    });

    expect(
      usage.windows.map(({ key, kind, label, windowDurationMins }) => ({
        key,
        kind,
        label,
        windowDurationMins,
      })),
    ).toEqual([
      { key: "codex:primary", kind: "session", label: "Usage", windowDurationMins: undefined },
      { key: "codex:secondary", kind: "weekly", label: "Secondary", windowDurationMins: undefined },
    ]);
  });

  it("keeps a lone duration-less primary as Usage instead of inventing a weekly window", () => {
    const usage = resolveCodexRateLimitSnapshotUsageLimits({
      checkedAt: CHECKED_AT,
      snapshot: {
        primary: { usedPercent: 100, resetsAt: PRIMARY_RESETS_AT_SECONDS },
      },
    });

    expect(usage.windows).toEqual([
      {
        key: "codex:primary",
        kind: "session",
        label: "Usage",
        usedPercent: 100,
        resetsAt: PRIMARY_RESETS_AT_ISO,
      },
    ]);
  });

  it("classifies near-weekly Codex durations with a 5 percent tolerance", () => {
    const usage = resolveCodexRateLimitSnapshotUsageLimits({
      checkedAt: CHECKED_AT,
      snapshot: {
        primary: { usedPercent: 42, windowDurationMins: 10_100 },
      },
    });

    expect(usage.windows.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: "weekly", label: "Weekly" },
    ]);
  });

  it("names a window after its reported duration rather than its position", () => {
    const usage = resolveCodexRateLimitSnapshotUsageLimits({
      checkedAt: CHECKED_AT,
      snapshot: {
        primary: { usedPercent: 42, windowDurationMins: 10080 },
      },
    });

    expect(usage.windows.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: "weekly", label: "Weekly" },
    ]);
  });

  it("omits windows with invalid percentages", () => {
    const usage = resolveCodexRateLimitSnapshotUsageLimits({
      checkedAt: CHECKED_AT,
      snapshot: {
        primary: { usedPercent: Number.NaN },
        secondary: { usedPercent: 50 },
      },
    });

    expect(usage.windows).toHaveLength(1);
    expect(usage.windows[0]?.kind).toBe("weekly");
  });

  it("omits out-of-range reset timestamps instead of throwing", () => {
    const usage = resolveCodexRateLimitSnapshotUsageLimits({
      checkedAt: CHECKED_AT,
      snapshot: {
        secondary: { usedPercent: 50, resetsAt: Number.MAX_VALUE, windowDurationMins: 10080 },
      },
    });

    expect(usage.available).toBe(true);
    expect(usage.windows[0]?.usedPercent).toBe(50);
    expect(usage.windows[0]?.resetsAt).toBeUndefined();
  });

  it("returns unavailable when no snapshot is reported", () => {
    expect(resolveCodexRateLimitSnapshotUsageLimits({ checkedAt: CHECKED_AT })).toEqual({
      source: "codexAppServer",
      available: false,
      reason: "No Codex subscription quota windows reported.",
      checkedAt: CHECKED_AT,
      windows: [],
    });
  });
});
