import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  makeUnavailableUsageLimits,
  makeUsageLimitsSnapshot,
  type RawUsageWindowInput,
} from "./providerUsageLimits.ts";

const CODEX_WINDOW_PRESENTATIONS = [
  { minutes: 5 * 60, kind: "session" as const, label: "Session" },
  { minutes: 24 * 60, kind: "session" as const, label: "Day" },
  { minutes: 7 * 24 * 60, kind: "weekly" as const, label: "Weekly" },
  { minutes: 30 * 24 * 60, kind: "monthly" as const, label: "Monthly" },
  { minutes: 365 * 24 * 60, kind: "monthly" as const, label: "Year" },
] as const;

const UNAVAILABLE_REASON = "No Codex subscription quota windows reported.";

function isApproximateCodexWindow(actualMinutes: number, expectedMinutes: number): boolean {
  return actualMinutes >= expectedMinutes * 0.95 && actualMinutes <= expectedMinutes * 1.05;
}

/** Minimal structural view of a Codex rate-limit window. */
export interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

/** Minimal structural view of a Codex rate-limit snapshot. */
export interface CodexRateLimitSnapshot {
  readonly planType?: string | null;
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
}

function epochSecondsToIso(value: number): string | undefined {
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

export function resolveCodexRateLimitSnapshotUsageLimits(input: {
  readonly checkedAt: string;
  readonly snapshot?: CodexRateLimitSnapshot | null;
}): ServerProviderUsageLimits {
  if (!input.snapshot) {
    return makeUnavailableUsageLimits({
      source: "codexAppServer",
      checkedAt: input.checkedAt,
      reason: UNAVAILABLE_REASON,
    });
  }

  const reported = [
    { window: input.snapshot.primary, position: "primary" as const },
    { window: input.snapshot.secondary, position: "secondary" as const },
  ].filter(
    (entry): entry is { window: CodexRateLimitWindow; position: "primary" | "secondary" } =>
      Boolean(entry.window) && Number.isFinite(entry.window?.usedPercent),
  );

  // Durations are classified with the Codex TUI's ±5% tolerance. Missing or
  // unknown durations keep a neutral label instead of guessing 5h vs weekly
  // from primary/secondary position.
  const windows: RawUsageWindowInput[] = reported.map(({ window, position }) => {
    const durationMins =
      typeof window.windowDurationMins === "number" && Number.isFinite(window.windowDurationMins)
        ? window.windowDurationMins
        : undefined;
    const known =
      durationMins === undefined
        ? undefined
        : CODEX_WINDOW_PRESENTATIONS.find((candidate) =>
            isApproximateCodexWindow(durationMins, candidate.minutes),
          );
    const resetsAt =
      typeof window.resetsAt === "number" ? epochSecondsToIso(window.resetsAt) : undefined;
    const kind = known?.kind ?? (position === "primary" ? "session" : "weekly");
    const label = known?.label ?? (position === "primary" ? "Usage" : "Secondary");
    const roundedDuration =
      durationMins === undefined ? undefined : Math.max(0, Math.round(durationMins));
    return {
      key: roundedDuration !== undefined ? `duration:${roundedDuration}` : `codex:${position}`,
      kind,
      label,
      usedPercent: window.usedPercent,
      ...(roundedDuration !== undefined ? { windowDurationMins: roundedDuration } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    };
  });

  return makeUsageLimitsSnapshot({
    source: "codexAppServer",
    checkedAt: input.checkedAt,
    windows,
    unavailableReason: UNAVAILABLE_REASON,
  });
}
