/**
 * devinUsageLimits — Devin plan quota to {@link ServerProviderUsageLimits}.
 *
 * Devin has no HTTP API of its own, so this never talks to Devin directly: a
 * CLIProxy hub fronting a Devin CLI shim publishes the quota and
 * {@link ../../usage/cliproxyApi} fetches it. Keeping the mapping pure here
 * matches `claudeUsageLimits` and `codexUsageLimits`.
 *
 * Devin reports plan quota as daily plus weekly (Max plans are weekly only),
 * and bills in ACUs rather than tokens — which is why only the percentage
 * windows map across, and no cost ever does.
 *
 * @module provider/Layers/devinUsageLimits
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";

/** One window as the hub's Devin shim reports it, already flipped to "used". */
export interface DevinQuotaWindowInput {
  readonly percent: number;
  readonly resets_at?: string | null | undefined;
  readonly period_hours?: number | undefined;
}

export interface DevinQuotaInput {
  readonly plan?: string | null | undefined;
  readonly usage: {
    readonly daily?: DevinQuotaWindowInput | undefined;
    readonly weekly?: DevinQuotaWindowInput | undefined;
  };
}

function toWindow(
  id: "daily" | "weekly",
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  raw: DevinQuotaWindowInput | undefined,
): ReadonlyArray<ServerProviderUsageWindow> {
  if (!raw || !Number.isFinite(raw.percent)) {
    return [];
  }
  return [
    {
      id,
      kind,
      label,
      usedPercent: Math.min(100, Math.max(0, Math.round(raw.percent))),
      ...(raw.resets_at ? { resetsAt: raw.resets_at } : {}),
      ...(raw.period_hours ? { windowDurationMins: raw.period_hours * 60 } : {}),
    },
  ];
}

/**
 * Windows for the signed-in Devin account, or `undefined` when the hub
 * reported nothing usable — the caller drops the account rather than showing
 * empty bars.
 *
 * `daily` maps to `other` because the contract's window kinds have no daily
 * bucket; `weekly` maps to `weekly` so it sorts with the other providers'
 * weekly allowances.
 */
export function devinQuotaToUsageLimits(input: {
  readonly checkedAt: string;
  readonly quota: DevinQuotaInput;
}): ServerProviderUsageLimits | undefined {
  const windows = [
    ...toWindow("daily", "other", "Daily", input.quota.usage.daily),
    ...toWindow("weekly", "weekly", "Weekly", input.quota.usage.weekly),
  ];
  return windows.length > 0 ? { checkedAt: input.checkedAt, windows } : undefined;
}
