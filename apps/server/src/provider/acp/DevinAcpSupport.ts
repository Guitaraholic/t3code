/**
 * DevinAcpSupport — spawn and session-configuration helpers for the Devin CLI
 * (`devin acp`, Cognition).
 *
 * Devin speaks plain ACP over stdio, so the shared
 * {@link AcpSessionRuntime} carries the protocol and this module only supplies
 * the Devin-specific launch and option plumbing.
 *
 * Two Devin behaviours drive the shape here:
 *
 *   - The **default** agent is the only one that advertises a `model` config
 *     option. `devin acp --agent-type summarizer` accepts `--model` on the
 *     command line but silently ignores it, so the agent type is deliberately
 *     left unset.
 *   - The advertised `model` option lists only the models the signed-in
 *     account's plan may actually use, while `devin models list` also returns
 *     plan-gated ones. Selecting through `session/set_config_option` therefore
 *     gets plan-correct gating for free, and a rejected value surfaces as an
 *     ACP error instead of Devin quietly answering from a different model.
 *
 * @module provider/acp/DevinAcpSupport
 */
import { type DevinSettings, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath">;

/**
 * T3's sentinel model id for Devin, matching `DEFAULT_MODEL_BY_PROVIDER`.
 * Means "leave the session on the model Devin already chose", which is the only
 * choice guaranteed to be valid on every plan.
 */
export const DEVIN_SESSION_DEFAULT_MODEL = "default";

/** `configOptions` id carrying the account's selectable models. */
export const DEVIN_MODEL_CONFIG_ID = "model";
/** `configOptions` id carrying the session permission mode. */
export const DEVIN_MODE_CONFIG_ID = "mode";

/**
 * Devin drives file edits through its own tools and asks for approval over
 * `session/request_permission`, which T3 already renders. Advertising the
 * client file system would instead route every edit through T3's own
 * read/write bridge, which this provider does not implement.
 */
export const DEVIN_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

/**
 * Devin session modes, most to least restrictive. `ask` answers without
 * editing, `plan` proposes before implementing, `accept-edits` (labelled
 * "Code") writes files, `bypass` auto-approves every tool call. `smart`
 * auto-approves only what the model judges safe.
 */
export function devinModeForRuntimeMode(runtimeMode: RuntimeMode | undefined): string | undefined {
  switch (runtimeMode) {
    case "approval-required":
      return "smart";
    case "auto-accept-edits":
      return "accept-edits";
    case "auto":
      return "smart";
    case "full-access":
      return "bypass";
    default:
      return undefined;
  }
}

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export interface DevinAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option";
  readonly configId?: string;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    // No `--agent-type`: only the default agent advertises a model option.
    // No `--model`: the model is applied after `session/new` so an unavailable
    // one fails loudly instead of falling back to the account default.
    command: devinSettings?.binaryPath || "devin",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
        clientCapabilities: DEVIN_CLIENT_CAPABILITIES,
        // No `authMethodId`, so the runtime never sends `session/authenticate`.
        // The only method Devin advertises is `devin-browser` ("Log in with
        // browser"): sending it opens a browser window and waits on a
        // 127.0.0.1 callback on *every* session start, signed in or not.
        // `devin auth login` owns the credential; the probe reads
        // `devin auth status` to report it.
        //
        // Devin rejects `session/new` with `-32602 missing field \`mcpServers\``
        // when the key is absent, and an explicit empty list also keeps a
        // health probe from booting the user's MCP servers.
        mcpServers: input.mcpServers ?? [],
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Devin names the same model differently per layer: `devin models list` and
 * the `--model` flag use family slugs (`swe-1.6-slow`, alias `swe`), while the
 * ACP option list carries variant ids (`swe-1-6-slow`). Comparing on a
 * dot/underscore-insensitive form lets a stored T3 model id match either.
 */
export function normalizeDevinModelToken(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replaceAll(".", "-").replaceAll("_", "-");
}

function findDevinConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  configId: string,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions?.find((option) => option.id === configId || option.category === configId);
}

/** `options` is either a flat list or a list of labelled groups; both flatten here. */
function flattenDevinSelectOptions(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<{ readonly value: string; readonly name: string }> {
  if (!option || option.type !== "select") {
    return [];
  }
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() }]
      : entry.options.map((child) => ({ value: child.value.trim(), name: child.name.trim() })),
  );
}

/** Option value whose value or name matches `requested`, or undefined. */
function matchDevinSelectValue(
  option: EffectAcpSchema.SessionConfigOption | undefined,
  requested: string,
): string | undefined {
  const wanted = normalizeDevinModelToken(requested);
  return flattenDevinSelectOptions(option).find(
    (candidate) =>
      normalizeDevinModelToken(candidate.value) === wanted ||
      normalizeDevinModelToken(candidate.name) === wanted,
  )?.value;
}

/** `currentValue` of a select option, or undefined for boolean options. */
function devinSelectCurrentValue(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): string | undefined {
  return option?.type === "select" ? option.currentValue : undefined;
}

/** Model ids the signed-in account may actually select in this session. */
export function devinModelValuesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<string> {
  return devinSelectableModelsFromConfigOptions(configOptions).map((candidate) => candidate.value);
}

/**
 * Selectable models with their labels, for building the picker's catalog.
 *
 * This is the only per-plan-correct source Devin exposes: `devin models list`
 * reports the whole platform catalog (including the third-party models Devin
 * can drive and models the account's plan forbids), with no field marking
 * which of them this account may use.
 */
export function devinSelectableModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<{ readonly value: string; readonly name: string }> {
  return flattenDevinSelectOptions(findDevinConfigOption(configOptions, DEVIN_MODEL_CONFIG_ID));
}

/**
 * Config-option writes that put this session on `model` and `runtimeMode`.
 *
 * A requested model the session does not advertise yields no update and is
 * reported through `unavailableModel`, so the caller can fail the turn rather
 * than let Devin answer from its default model under the requested name.
 */
export function resolveDevinAcpConfigUpdates(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined;
  readonly model: string | null | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
}): {
  readonly updates: ReadonlyArray<{ readonly configId: string; readonly value: string }>;
  readonly unavailableModel?: {
    readonly requested: string;
    readonly available: ReadonlyArray<string>;
  };
} {
  const updates: Array<{ readonly configId: string; readonly value: string }> = [];

  const requestedModel = input.model?.trim();
  // `default` is T3's sentinel for "whatever this session already runs on".
  // Devin's per-plan catalog means there is no id that is always valid, so the
  // sentinel is the provider default and must never be sent to the agent.
  if (requestedModel && requestedModel !== DEVIN_SESSION_DEFAULT_MODEL) {
    const modelOption = findDevinConfigOption(input.configOptions, DEVIN_MODEL_CONFIG_ID);
    const value = matchDevinSelectValue(modelOption, requestedModel);
    if (value) {
      if (
        normalizeDevinModelToken(devinSelectCurrentValue(modelOption)) !==
        normalizeDevinModelToken(value)
      ) {
        updates.push({ configId: modelOption?.id ?? DEVIN_MODEL_CONFIG_ID, value });
      }
    } else if (modelOption) {
      return {
        updates: [],
        unavailableModel: {
          requested: requestedModel,
          available: devinModelValuesFromConfigOptions(input.configOptions),
        },
      };
    }
  }

  const requestedMode = devinModeForRuntimeMode(input.runtimeMode);
  if (requestedMode) {
    const modeOption = findDevinConfigOption(input.configOptions, DEVIN_MODE_CONFIG_ID);
    const value = matchDevinSelectValue(modeOption, requestedMode);
    if (
      value &&
      normalizeDevinModelToken(devinSelectCurrentValue(modeOption)) !==
        normalizeDevinModelToken(value)
    ) {
      updates.push({ configId: modeOption?.id ?? DEVIN_MODE_CONFIG_ID, value });
    }
  }

  return { updates };
}

/**
 * Devin's own models, as opposed to the third-party ones it can drive.
 *
 * Devin advertises 49 model families and only the `swe-*` ones are its own;
 * the rest are Claude, GPT, Gemini and friends running on Devin's quota. A
 * user who already pays those vendors directly does not want their Devin
 * subscription spent on them.
 *
 * `adaptive` and `fusion` are deliberately excluded: they are routers, and
 * what they route to may well be one of the third-party models.
 */
export function isDevinOwnModel(value: string): boolean {
  return normalizeDevinModelToken(value).startsWith("swe-");
}

/** Devin's JSON-RPC code for "this session is open in another process". */
const DEVIN_SESSION_LOCKED_CODE = -32015;

/**
 * Whether a failed `session/load` is Devin's single-writer lock rather than a
 * real fault.
 *
 * Devin allows one process per session and reports `-32015` with
 * `cognition.ai/errorKind: session_locked` and `retryable: true`. The usual
 * cause is a lock still held by a `devin acp` child that is on its way out —
 * after T3 restarts, for instance — so the session becomes loadable again
 * within seconds. The chain is walked because the runtime wraps the RPC error
 * in an `AcpTransportError`.
 */
export function isDevinSessionLockedError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      readonly code?: unknown;
      readonly data?: Record<string, unknown>;
      readonly errorMessage?: unknown;
      readonly message?: unknown;
      readonly cause?: unknown;
    };
    if (candidate.code === DEVIN_SESSION_LOCKED_CODE) return true;
    if (candidate.data?.["cognition.ai/errorKind"] === "session_locked") return true;
    for (const text of [candidate.errorMessage, candidate.message]) {
      if (typeof text === "string" && /already open in another process/i.test(text)) return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Whether starting a session failed while *resuming* one, as opposed to
 * failing outright.
 *
 * Devin can leave a session that neither T3 nor its own CLI can reopen —
 * `session/load` simply never answers, so the turn dies on a timeout with no
 * error code to match on. The method name is the only reliable signal, and it
 * arrives wrapped, so the whole cause chain is searched.
 */
export function isDevinSessionLoadFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      readonly method?: unknown;
      readonly detail?: unknown;
      readonly message?: unknown;
      readonly cause?: unknown;
    };
    if (candidate.method === "session/load") return true;
    for (const text of [candidate.detail, candidate.message]) {
      if (typeof text === "string" && text.includes("session/load")) return true;
    }
    current = candidate.cause;
  }
  return false;
}
