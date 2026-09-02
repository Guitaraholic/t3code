import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";

export interface RawUsageWindowInput {
  readonly key?: string;
  readonly kind?: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt?: string;
  readonly windowDurationMins?: number;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function isApproximateDuration(actual: number, expected: number): boolean {
  return actual >= expected * 0.95 && actual <= expected * 1.05;
}

export function windowKindFromDuration(input: {
  readonly windowDurationMins?: number;
  readonly shortestWindowDurationMins?: number;
  readonly longestWindowDurationMins?: number;
}): ServerProviderUsageWindow["kind"] | undefined {
  const duration = input.windowDurationMins;
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    return undefined;
  }
  if (
    isApproximateDuration(duration, 365 * 24 * 60) ||
    isApproximateDuration(duration, 30 * 24 * 60) ||
    duration >= 30 * 24 * 60
  ) {
    return "monthly";
  }
  if (
    isApproximateDuration(duration, 7 * 24 * 60) ||
    duration >= 7 * 24 * 60 ||
    (duration === input.longestWindowDurationMins &&
      input.longestWindowDurationMins !== input.shortestWindowDurationMins)
  ) {
    return "weekly";
  }
  return "session";
}

function compareUsageWindowKinds(
  left: ServerProviderUsageWindow["kind"],
  right: ServerProviderUsageWindow["kind"],
): number {
  const order = { session: 0, weekly: 1, monthly: 2 } as const;
  return order[left] - order[right];
}

/**
 * Stable identity for upsert, live-patch epochs, and list keys. Prefer the
 * provider's own id; fall back to the display triple for payloads that predate
 * `key`.
 */
export function usageWindowIdentity(
  window: Pick<ServerProviderUsageWindow, "key" | "kind" | "label" | "windowDurationMins">,
): string {
  const key = window.key?.trim();
  return key && key.length > 0
    ? key
    : `${window.kind}:${window.label}:${window.windowDurationMins ?? ""}`;
}

function defaultUsageWindowKey(
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  windowDurationMins: number | undefined,
): string {
  return usageWindowIdentity({ kind, label, windowDurationMins });
}

export function normalizeUsageWindows(
  windows: ReadonlyArray<RawUsageWindowInput>,
): ReadonlyArray<ServerProviderUsageWindow> {
  const normalizedDurations = windows
    .map((window) => window.windowDurationMins)
    .filter(
      (duration): duration is number => typeof duration === "number" && Number.isFinite(duration),
    )
    .toSorted((left, right) => left - right);
  const shortestWindowDurationMins = normalizedDurations[0];
  const longestWindowDurationMins = normalizedDurations.at(-1);

  return windows
    .flatMap((window) => {
      const kind =
        window.kind ??
        windowKindFromDuration({
          ...(typeof window.windowDurationMins === "number"
            ? { windowDurationMins: window.windowDurationMins }
            : {}),
          ...(typeof shortestWindowDurationMins === "number" ? { shortestWindowDurationMins } : {}),
          ...(typeof longestWindowDurationMins === "number" ? { longestWindowDurationMins } : {}),
        });
      if (!kind) {
        return [];
      }
      const trimmedLabel = window.label.trim();
      const defaultLabel =
        kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : "Monthly";
      const label = trimmedLabel.length > 0 ? trimmedLabel : defaultLabel;
      const windowDurationMins =
        typeof window.windowDurationMins === "number" && Number.isFinite(window.windowDurationMins)
          ? Math.max(0, Math.round(window.windowDurationMins))
          : undefined;
      const providedKey = window.key?.trim();
      return [
        {
          key:
            providedKey && providedKey.length > 0
              ? providedKey
              : defaultUsageWindowKey(kind, label, windowDurationMins),
          kind,
          label,
          usedPercent: clampPercent(window.usedPercent),
          ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
          ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
        } satisfies ServerProviderUsageWindow,
      ];
    })
    .toSorted((left, right) => compareUsageWindowKinds(left.kind, right.kind));
}

export function makeUnavailableUsageLimits(input: {
  readonly source: ServerProviderUsageLimits["source"];
  readonly checkedAt: string;
  readonly reason?: string;
}): ServerProviderUsageLimits {
  return {
    source: input.source,
    available: false,
    reason: input.reason ?? "Unable to fetch usage",
    windows: [],
    checkedAt: input.checkedAt,
  };
}

/**
 * Fold a rolling usage update into the windows already on a snapshot.
 *
 * Both runtime sources emit *sparse* updates — Claude's `rate_limit_event`
 * carries one window at a time and Codex documents its notification as a
 * partial to merge into the last full read — so an update must upsert by
 * {@link usageWindowIdentity} rather than replace the array, and must keep the
 * previous `resetsAt` / `windowDurationMins` when the update omits them.
 * Otherwise a percent-only event would drop the reset timestamp a probe had
 * already resolved.
 */
export function mergeUsageLimitWindows(
  previous: ReadonlyArray<ServerProviderUsageWindow>,
  incoming: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  const merged = new Map(previous.map((window) => [usageWindowIdentity(window), window] as const));
  for (const window of incoming) {
    const existing = merged.get(usageWindowIdentity(window));
    merged.set(usageWindowIdentity(window), {
      ...window,
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    });
  }
  return [...merged.values()].toSorted((left, right) =>
    compareUsageWindowKinds(left.kind, right.kind),
  );
}

function sameUsageWindow(
  left: ServerProviderUsageWindow,
  right: ServerProviderUsageWindow,
): boolean {
  return (
    usageWindowIdentity(left) === usageWindowIdentity(right) &&
    left.kind === right.kind &&
    left.label === right.label &&
    left.usedPercent === right.usedPercent &&
    left.resetsAt === right.resetsAt &&
    left.windowDurationMins === right.windowDurationMins
  );
}

function sameUsageWindows(
  left: ReadonlyArray<ServerProviderUsageWindow>,
  right: ReadonlyArray<ServerProviderUsageWindow>,
): boolean {
  return (
    left.length === right.length &&
    left.every((window, index) => {
      const other = right[index];
      return other !== undefined && sameUsageWindow(window, other);
    })
  );
}

/**
 * Apply a runtime usage update to whatever snapshot the provider currently
 * publishes. Returns `previous` untouched when the update carries no usable
 * window, or when the bars did not move: a rolling event that only restamps
 * `checkedAt` must not republish the whole provider snapshot.
 */
export function applyRuntimeUsageLimits(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly source: ServerProviderUsageLimits["source"];
  readonly checkedAt: string;
  readonly windows: ReadonlyArray<RawUsageWindowInput>;
}): ServerProviderUsageLimits | undefined {
  const incoming = normalizeUsageWindows(input.windows);
  if (incoming.length === 0) {
    return input.previous;
  }

  const previousWindows =
    input.previous?.available === true ? input.previous.windows : ([] as const);
  const windows = mergeUsageLimitWindows(previousWindows, incoming);
  if (
    input.previous?.available === true &&
    input.previous.source === input.source &&
    sameUsageWindows(input.previous.windows, windows)
  ) {
    return input.previous;
  }

  return {
    source: input.source,
    available: true,
    windows,
    checkedAt: input.checkedAt,
  };
}

/**
 * API-key and Bedrock accounts cannot report subscription windows. That
 * unavailable snapshot must replace previously available bars (a user who
 * switched off a subscription), unlike a timed-out `/usage` probe which
 * should keep the last good snapshot.
 */
export function isAuthoritativeUsageUnavailable(
  limits: ServerProviderUsageLimits | undefined,
): boolean {
  return (
    limits?.available === false &&
    (/\bAPI key\b/i.test(limits.reason ?? "") || /\bBedrock\b/i.test(limits.reason ?? ""))
  );
}

/**
 * Choose usage limits after a status probe finishes.
 *
 * Live `account.rate-limits.updated` patches land on the published snapshot
 * while `checkProvider` is still running. The probe's `checkedAt` is stamped
 * when it completes, so it always looks newer than those patches. If a live
 * write happened during the wait, fold only its patched windows on top of the
 * probe. A probe that comes back unavailable must not wipe bars a previous
 * probe or live event already established, unless the account itself cannot
 * have usage (API key).
 */
export function resolveUsageLimitsAfterRefresh(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
  readonly livePatchedWindows: ReadonlyArray<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits | undefined {
  const { published, probed, livePatchedWindows } = input;
  if (probed === undefined) {
    return published;
  }
  if (isAuthoritativeUsageUnavailable(probed)) {
    return probed;
  }
  if (published?.available === true && probed.available !== true) {
    return published;
  }
  if (
    livePatchedWindows.length > 0 &&
    published?.available === true &&
    probed?.available === true
  ) {
    return {
      source: published.source,
      available: true,
      checkedAt: published.checkedAt,
      windows: mergeUsageLimitWindows(probed.windows, livePatchedWindows),
    };
  }
  return probed;
}

export function makeUsageLimitsSnapshot(input: {
  readonly source: ServerProviderUsageLimits["source"];
  readonly checkedAt: string;
  readonly windows: ReadonlyArray<RawUsageWindowInput>;
  readonly unavailableReason: string;
}): ServerProviderUsageLimits {
  const normalizedWindows = normalizeUsageWindows(input.windows);
  if (normalizedWindows.length === 0) {
    return makeUnavailableUsageLimits({
      source: input.source,
      checkedAt: input.checkedAt,
      reason: input.unavailableReason,
    });
  }

  return {
    source: input.source,
    available: true,
    windows: normalizedWindows,
    checkedAt: input.checkedAt,
  };
}
