/**
 * DevinProvider — health probe and model catalog for the Devin CLI (Cognition).
 *
 * The probe deliberately stops at `initialize`. `session/new` is what makes
 * Devin load workspace rules and skills and register a session row, so opening
 * one on a background health check would create churn the user never asked for
 * (see "Setup must not happen as a health-check side effect" in
 * docs/internals/providers.md).
 *
 * The catalog, however, comes from the session's `model` config option, which
 * is the only per-plan-correct list Devin exposes. `devin models list` reports
 * the entire platform catalog — every third-party model Devin can drive, plus
 * models this account's plan forbids — and carries no field saying which is
 * which, so using it as the catalog fills the picker with models that cannot
 * be chosen. Reading the option costs one `session/new` against a scratch
 * directory, which keeps the user's workspace rules out of the probe.
 *
 * The adapter still applies the model through `session/set_config_option` at
 * turn start, where an unavailable model fails loudly with the selectable
 * list. Devin's own fallback — log a warning and quietly answer from a
 * different model — is never allowed to reach the user.
 *
 * @module provider/Layers/DevinProvider
 */
import {
  type CustomModelSetting,
  type DevinSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  devinSelectableModelsFromConfigOptions,
  isDevinOwnModel,
  makeDevinAcpRuntime,
  normalizeDevinModelToken,
} from "../acp/DevinAcpSupport.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
/** `session/new` adds a round trip to Cognition on top of a cold binary start. */
const DEVIN_ACP_SESSION_PROBE_TIMEOUT_MS = 20_000;
/** Listing models is a network round trip against Cognition's API. */
const MODELS_PROBE_TIMEOUT_MS = 15_000;

export function buildInitialDevinProviderSnapshot(
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = devinModelsFromSettings(devinSettings.customModels);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });
}

function devinModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Turns the session's selectable model options into catalog entries, borrowing
 * a nicer label from `devin models list` when the ids line up. They often do
 * not: the option list uses variant ids (`swe-1-6-slow`) while the catalog is
 * keyed by family slug (`swe-1.6-slow`), hence the normalized comparison.
 */
function devinModelsFromSelectable(
  selectable: ReadonlyArray<{ readonly value: string; readonly name: string }>,
  discovered: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const byToken = new Map(
    discovered.map((model) => [normalizeDevinModelToken(model.slug), model] as const),
  );
  return selectable.map((option) => {
    const match = byToken.get(normalizeDevinModelToken(option.value));
    return {
      slug: option.value,
      name: option.name || match?.name || option.value,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    } satisfies ServerProviderModel;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/**
 * Parses `devin models list --format json`.
 *
 * Shape is `{ families: [{ slug, family_label, aliases, variants: [...] }] }`.
 * T3 keys on the family slug because that is what both `--model` and the ACP
 * `model` config option resolve against; the per-family variants are effort
 * levels rather than separate models.
 */
export function parseDevinModelsJson(raw: string): ReadonlyArray<ServerProviderModel> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.families)) {
    return [];
  }

  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const family of parsed.families) {
    if (!isRecord(family)) {
      continue;
    }
    const slug = nonEmptyString(family.slug);
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: nonEmptyString(family.family_label) ?? slug,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return models;
}

/**
 * Reads `devin auth status`. The command prints its verdict rather than
 * signalling through the exit code, so the text is the signal.
 */
export function parseDevinAuthStatus(output: string): boolean | null {
  if (/not logged in/i.test(output)) {
    return false;
  }
  if (/logged in/i.test(output)) {
    return true;
  }
  return null;
}

const runDevinCliCommand = (
  devinSettings: DevinSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Confirms the agent speaks ACP without creating a session. `initialize` alone
 * cannot open a browser login or boot the workspace's MCP servers.
 */
/**
 * Opens a throwaway session purely to read which models this account may pick.
 *
 * Deliberately rooted at a scratch directory rather than the user's project:
 * `session/new` makes Devin scan the cwd for rules and skills, and a health
 * check has no business loading a repository's agent configuration.
 */
const probeDevinAcpSelectableModels = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const scratchDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-devin-probe-" });
    const acp = yield* makeDevinAcpRuntime({
      devinSettings,
      environment,
      childProcessSpawner,
      cwd: scratchDir,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    yield* acp.start();
    return devinSelectableModelsFromConfigOptions(yield* acp.getConfigOptions);
  }).pipe(Effect.scoped);

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = devinModelsFromSettings(devinSettings.customModels);

  if (!devinSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDevinCliCommand(devinSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  const authResult = yield* runDevinCliCommand(devinSettings, ["auth", "status"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const authOutput =
    Result.isSuccess(authResult) && Option.isSome(authResult.success)
      ? authResult.success.value
      : undefined;
  const authenticated = authOutput
    ? parseDevinAuthStatus(`${authOutput.stdout}\n${authOutput.stderr}`)
    : null;

  const auth: ServerProviderAuth =
    authenticated === true
      ? { status: "authenticated", type: "cached_token", label: "Devin account" }
      : authenticated === false
        ? { status: "unauthenticated" }
        : { status: "unknown" };

  if (authenticated === false) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "Devin CLI is installed but not logged in. Run `devin auth login`.",
      },
    });
  }

  // Only meaningful once signed in; unauthenticated the command errors out.
  const modelsResult = yield* runDevinCliCommand(
    devinSettings,
    ["models", "list", "--format", "json"],
    environment,
  ).pipe(Effect.timeoutOption(MODELS_PROBE_TIMEOUT_MS), Effect.result);
  const modelsOutput =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? modelsResult.success.value
      : undefined;
  const discoveredModels = modelsOutput ? parseDevinModelsJson(modelsOutput.stdout) : [];
  if (!modelsOutput) {
    yield* Effect.logWarning("Devin CLI model listing failed or timed out.", {
      errorTag: Result.isFailure(modelsResult)
        ? modelsResult.failure._tag
        : Option.isNone(modelsResult.success)
          ? "Timeout"
          : `ExitCode${modelsResult.success.value.code}`,
    });
  }

  const acpExit = yield* probeDevinAcpSelectableModels(devinSettings, environment).pipe(
    Effect.timeoutOption(DEVIN_ACP_SESSION_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  const acpFailed = Exit.isFailure(acpExit) || Option.isNone(acpExit.value);
  if (acpFailed) {
    yield* Effect.logWarning("Devin ACP session probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
  }
  const allSelectableModels = acpFailed ? [] : Option.getOrElse(acpExit.value, () => []);
  const devinOwnModels = allSelectableModels.filter((option) => isDevinOwnModel(option.value));
  // Never let the preference empty the picker: if a plan somehow offers no SWE
  // model at all, showing everything selectable beats showing nothing.
  const selectableModels =
    devinSettings.sweModelsOnly && devinOwnModels.length > 0 ? devinOwnModels : allSelectableModels;

  // `devin models list` is kept only for its labels; the selectable option is
  // what decides membership, so a model the plan forbids never reaches the
  // picker even though the catalog still lists it.
  const models =
    selectableModels.length > 0
      ? devinModelsFromSettings(
          devinSettings.customModels,
          devinModelsFromSelectable(selectableModels, discoveredModels),
        )
      : discoveredModels.length > 0
        ? devinModelsFromSettings(devinSettings.customModels, discoveredModels)
        : fallbackModels;

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: devinSettings.enabled,
    checkedAt,
    models,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      // A failed ACP probe degrades chat, unlike a failed catalog fetch which
      // only degrades the picker.
      status: acpFailed ? "error" : "ready",
      auth,
      ...(acpFailed ? { message: "Devin CLI is installed but its ACP agent did not start." } : {}),
    },
  });
});

export const enrichDevinSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
