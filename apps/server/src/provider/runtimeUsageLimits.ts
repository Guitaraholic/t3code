/**
 * Runtime usage-limit telemetry — turns `account.rate-limits.updated` payloads
 * into usage windows.
 *
 * Claude and Codex both push rate-limit updates over their session runtime
 * while a turn is streaming, which is fresher than the periodic status probes
 * and costs nothing extra to read. The payloads are declared `Schema.Unknown`
 * on the wire (`AccountRateLimitsUpdatedPayload`), so everything here is
 * structural parsing with a `undefined` result for anything unrecognized.
 *
 * @module provider/runtimeUsageLimits
 */
import type { ProviderDriverKind, ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  resolveCodexRateLimitSnapshotUsageLimits,
  type CodexRateLimitSnapshot,
} from "./codexUsageProbe.ts";
import type { RawUsageWindowInput } from "./providerUsageLimits.ts";

const CLAUDE_SESSION_WINDOW = { label: "Session", windowDurationMins: 5 * 60 } as const;
const CLAUDE_WEEKLY_WINDOW = { label: "Weekly", windowDurationMins: 7 * 24 * 60 } as const;

function claudeScopedWeeklyLabel(type: string, info: Readonly<Record<string, unknown>>): string {
  const scope = readRecord(info.scope);
  const model = readRecord(scope?.model);
  const displayName = typeof model?.display_name === "string" ? model.display_name.trim() : "";
  if (displayName.length > 0) {
    return displayName;
  }
  const suffix = type
    .replace(/^seven_day_/, "")
    .replace(/_/g, " ")
    .trim();
  return suffix.length > 0 ? suffix.replace(/\b\w/g, (char) => char.toUpperCase()) : "Weekly";
}

function claudeWindowFromRateLimitType(
  type: string,
  info: Readonly<Record<string, unknown>>,
): { readonly label: string; readonly windowDurationMins: number } | undefined {
  if (type === "five_hour") {
    return CLAUDE_SESSION_WINDOW;
  }
  if (type === "seven_day") {
    return CLAUDE_WEEKLY_WINDOW;
  }
  if (type === "overage") {
    return undefined;
  }
  if (type === "weekly_scoped" || type.startsWith("seven_day_")) {
    return {
      label: claudeScopedWeeklyLabel(type, info),
      windowDurationMins: CLAUDE_WEEKLY_WINDOW.windowDurationMins,
    };
  }
  return undefined;
}

export interface RuntimeUsageLimitsUpdate {
  readonly source: ServerProviderUsageLimits["source"];
  readonly windows: ReadonlyArray<RawUsageWindowInput>;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Both CLIs report resets as epoch *seconds*, but a millisecond value would
 * decode as a date ~50000 years out rather than failing, so scale anything
 * already large enough to be milliseconds.
 */
function epochToIso(value: number | undefined): string | undefined {
  if (value === undefined || value <= 0 || !Number.isFinite(value)) {
    return undefined;
  }
  const millis = value > 1e12 ? value : value * 1000;
  const dt = DateTime.make(millis);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function readClaudeRateLimitType(info: Readonly<Record<string, unknown>>): string | undefined {
  const raw = info.rateLimitType ?? info.rate_limit_type;
  return typeof raw === "string" ? raw : undefined;
}

function readClaudeResetsAt(info: Readonly<Record<string, unknown>>): string | undefined {
  const raw = info.resetsAt ?? info.resets_at;
  const asNumber = readFiniteNumber(raw);
  if (asNumber !== undefined) {
    return epochToIso(asNumber);
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const dt = DateTime.make(raw);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

/**
 * Claude's live `rate_limit_event` reports `utilization` as a 0–1 fraction
 * (`0.85` = 85%). Values already above 1 are treated as percents so a
 * percent-scaled payload still maps onto the bar. `usedPercent`, when present,
 * is already 0–100 and is not scaled again.
 */
function claudeUtilizationToUsedPercent(value: number): number {
  return value <= 1 ? value * 100 : value;
}

export function parseClaudeRuntimeUsageWindows(
  rateLimits: unknown,
): ReadonlyArray<RawUsageWindowInput> {
  const event = readRecord(rateLimits);
  const nested = readRecord(event?.rateLimits);
  const info =
    readRecord(event?.rate_limit_info) ??
    readRecord(event?.rateLimitInfo) ??
    readRecord(nested?.rate_limit_info) ??
    event;
  if (!info) {
    return [];
  }
  const rateLimitType = readClaudeRateLimitType(info);
  const window = rateLimitType ? claudeWindowFromRateLimitType(rateLimitType, info) : undefined;
  const usedPercentRaw = readFiniteNumber(info.usedPercent);
  const utilization = readFiniteNumber(info.utilization);
  const usedPercent =
    usedPercentRaw !== undefined
      ? usedPercentRaw
      : utilization !== undefined
        ? claudeUtilizationToUsedPercent(utilization)
        : undefined;
  if (!window || usedPercent === undefined) {
    return [];
  }

  const resetsAt = readClaudeResetsAt(info);
  return [
    {
      label: window.label,
      usedPercent,
      windowDurationMins: window.windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    },
  ];
}

export function parseCodexRuntimeUsageWindows(
  rateLimits: unknown,
  checkedAt: string,
): ReadonlyArray<RawUsageWindowInput> {
  const payload = readRecord(rateLimits);
  // The adapter forwards the notification verbatim, so the snapshot may be the
  // payload itself or sit under its `rateLimits` key.
  const snapshot = readRecord(payload?.rateLimits) ?? payload;
  if (!snapshot) {
    return [];
  }

  // Reuse the probe's window resolution so a rolling notification and a full
  // `account/rateLimits/read` produce identical windows, then project back to
  // raw inputs for the shared normalizer.
  const resolved = resolveCodexRateLimitSnapshotUsageLimits({
    checkedAt,
    snapshot: snapshot as CodexRateLimitSnapshot,
  });
  if (!resolved.available) {
    return [];
  }

  return resolved.windows.map((window) => ({
    label: window.label,
    usedPercent: window.usedPercent,
    ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    ...(window.windowDurationMins !== undefined
      ? { windowDurationMins: window.windowDurationMins }
      : {}),
  }));
}

/**
 * Map an `account.rate-limits.updated` payload onto usage windows for the
 * driver that emitted it. Returns `undefined` when the driver has no runtime
 * rate-limit telemetry or the payload carries nothing usable — callers keep
 * the previous snapshot in that case.
 */
function isClaudeDriverKind(driverKind: ProviderDriverKind): boolean {
  return driverKind === "claudeAgent" || driverKind === "claude";
}

export function parseRuntimeUsageLimitsUpdate(input: {
  readonly driverKind: ProviderDriverKind;
  readonly rateLimits: unknown;
  readonly checkedAt: string;
}): RuntimeUsageLimitsUpdate | undefined {
  const { windows, source } = isClaudeDriverKind(input.driverKind)
    ? {
        windows: parseClaudeRuntimeUsageWindows(input.rateLimits),
        source: "claudeStatusProbe" as const,
      }
    : input.driverKind === "codex"
      ? {
          windows: parseCodexRuntimeUsageWindows(input.rateLimits, input.checkedAt),
          source: "codexAppServer" as const,
        }
      : { windows: [], source: "codexAppServer" as const };

  return windows.length > 0 ? { source, windows } : undefined;
}
