import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildDevinAcpSpawnInput,
  devinModeForRuntimeMode,
  devinModelValuesFromConfigOptions,
  devinSelectableModelsFromConfigOptions,
  isDevinOwnModel,
  isDevinSessionLoadFailure,
  isDevinSessionLockedError,
  normalizeDevinModelToken,
  resolveDevinAcpConfigUpdates,
} from "./DevinAcpSupport.ts";

const modelOption = (
  currentValue: string,
  values: ReadonlyArray<string>,
): EffectAcpSchema.SessionConfigOption =>
  ({
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  }) as EffectAcpSchema.SessionConfigOption;

const modeOption = (currentValue: string): EffectAcpSchema.SessionConfigOption =>
  ({
    type: "select",
    id: "mode",
    name: "Session Mode",
    category: "mode",
    currentValue,
    options: [
      { value: "accept-edits", name: "Code" },
      { value: "smart", name: "Smart" },
      { value: "ask", name: "Ask" },
      { value: "plan", name: "Plan" },
      { value: "bypass", name: "Bypass Permissions" },
    ],
  }) as EffectAcpSchema.SessionConfigOption;

describe("buildDevinAcpSpawnInput", () => {
  it("launches the default agent without binding a model on the command line", () => {
    // `--agent-type summarizer` accepts `--model` and ignores it, and a model
    // passed here falls back silently when the plan disallows it. Both are why
    // the launch stays bare and the model is applied after session/new.
    expect(buildDevinAcpSpawnInput(null, "/repo")).toEqual({
      command: "devin",
      args: ["acp"],
      cwd: "/repo",
    });
  });

  it("honours a configured binary path", () => {
    expect(buildDevinAcpSpawnInput({ binaryPath: "/opt/devin" }, "/repo").command).toBe(
      "/opt/devin",
    );
  });
});

describe("devinModeForRuntimeMode", () => {
  it("maps T3 runtime modes onto Devin session modes", () => {
    expect(devinModeForRuntimeMode("auto-accept-edits")).toBe("accept-edits");
    expect(devinModeForRuntimeMode("full-access")).toBe("bypass");
    expect(devinModeForRuntimeMode("approval-required")).toBe("smart");
  });

  it("leaves the session alone when T3 has no opinion", () => {
    expect(devinModeForRuntimeMode(undefined)).toBeUndefined();
  });
});

describe("normalizeDevinModelToken", () => {
  it("treats family slugs and ACP variant ids as the same model", () => {
    // `devin models list` says swe-1.6-slow; the ACP option list says swe-1-6-slow.
    expect(normalizeDevinModelToken("swe-1.6-slow")).toBe(normalizeDevinModelToken("swe-1-6-slow"));
  });
});

describe("devinModelValuesFromConfigOptions", () => {
  it("reports the models the session actually offers", () => {
    expect(
      devinModelValuesFromConfigOptions([modelOption("swe-1-6-slow", ["swe-1-6-slow", "swe-1-7"])]),
    ).toEqual(["swe-1-6-slow", "swe-1-7"]);
  });

  it("returns nothing when the agent advertises no model option", () => {
    expect(devinModelValuesFromConfigOptions([modeOption("accept-edits")])).toEqual([]);
    expect(devinModelValuesFromConfigOptions(undefined)).toEqual([]);
  });
});

describe("resolveDevinAcpConfigUpdates", () => {
  it("selects a requested model that differs from the session's current one", () => {
    const { updates, unavailableModel } = resolveDevinAcpConfigUpdates({
      configOptions: [modelOption("swe-1-6-slow", ["swe-1-6-slow", "swe-1-7"])],
      model: "swe-1.7",
    });
    expect(unavailableModel).toBeUndefined();
    expect(updates).toEqual([{ configId: "model", value: "swe-1-7" }]);
  });

  it("does not rewrite a model the session already runs", () => {
    const { updates } = resolveDevinAcpConfigUpdates({
      configOptions: [modelOption("swe-1-6-slow", ["swe-1-6-slow"])],
      model: "swe-1.6-slow",
    });
    expect(updates).toEqual([]);
  });

  it("reports a plan-gated model instead of letting Devin substitute one", () => {
    // Devin logs a stderr warning and answers from its default model. Surfacing
    // that as an error is what keeps T3 from attributing one model's output to
    // another.
    const { updates, unavailableModel } = resolveDevinAcpConfigUpdates({
      configOptions: [modelOption("swe-1-6-slow", ["swe-1-6-slow"])],
      model: "swe-2",
    });
    expect(updates).toEqual([]);
    expect(unavailableModel).toEqual({ requested: "swe-2", available: ["swe-1-6-slow"] });
  });

  it("passes the session-default sentinel through untouched", () => {
    const { updates, unavailableModel } = resolveDevinAcpConfigUpdates({
      configOptions: [modelOption("swe-1-6-slow", ["swe-1-6-slow"])],
      model: "default",
    });
    expect(unavailableModel).toBeUndefined();
    expect(updates).toEqual([]);
  });

  it("switches session mode for the requested runtime mode", () => {
    const { updates } = resolveDevinAcpConfigUpdates({
      configOptions: [modeOption("accept-edits")],
      model: undefined,
      runtimeMode: "full-access",
    });
    expect(updates).toEqual([{ configId: "mode", value: "bypass" }]);
  });

  it("leaves the mode alone when it already matches", () => {
    const { updates } = resolveDevinAcpConfigUpdates({
      configOptions: [modeOption("bypass")],
      model: undefined,
      runtimeMode: "full-access",
    });
    expect(updates).toEqual([]);
  });
});

describe("devinSelectableModelsFromConfigOptions", () => {
  it("carries each selectable model's label for the picker", () => {
    expect(
      devinSelectableModelsFromConfigOptions([
        modelOption("swe-1-6-slow", ["swe-1-6-slow", "swe-1-7"]),
      ]),
    ).toEqual([
      { value: "swe-1-6-slow", name: "swe-1-6-slow" },
      { value: "swe-1-7", name: "swe-1-7" },
    ]);
  });

  // A Free account advertises exactly one model while `devin models list`
  // still reports the whole platform catalog. The option is what the picker
  // must believe, so an empty or absent one yields nothing rather than
  // falling back to something the account cannot select.
  it("is empty when the session advertises no model option", () => {
    expect(devinSelectableModelsFromConfigOptions([])).toEqual([]);
    expect(devinSelectableModelsFromConfigOptions(undefined)).toEqual([]);
  });
});

describe("isDevinOwnModel", () => {
  it("keeps the SWE family across both id spellings", () => {
    // The option list uses variant ids (swe-1-6-slow) while the CLI catalog
    // uses family slugs (swe-1.6-slow); both must be recognised.
    for (const id of ["swe-2", "swe-1-6-slow", "swe-1.6-slow", "swe-1.7-lightning"]) {
      expect(isDevinOwnModel(id)).toBe(true);
    }
  });

  it("rejects the third-party models Devin can drive", () => {
    for (const id of ["claude-opus-5", "gpt-6-astra", "gemini-3.8-flash", "grok-4.6"]) {
      expect(isDevinOwnModel(id)).toBe(false);
    }
  });

  // Routers, not models: what they pick may itself be a third-party model, so
  // they cannot be treated as "Devin's own".
  it("rejects the routing pseudo-models", () => {
    expect(isDevinOwnModel("adaptive")).toBe(false);
    expect(isDevinOwnModel("fusion")).toBe(false);
  });
});

describe("isDevinSessionLockedError", () => {
  // Devin reports the lock once, but the runtime wraps the RPC failure in an
  // AcpTransportError, so the whole cause chain has to be inspected.
  it("finds the lock however deeply it is wrapped", () => {
    expect(isDevinSessionLockedError({ code: -32015 })).toBe(true);
    expect(isDevinSessionLockedError({ cause: { cause: { code: -32015 } } })).toBe(true);
    expect(
      isDevinSessionLockedError({
        cause: { data: { "cognition.ai/errorKind": "session_locked" } },
      }),
    ).toBe(true);
    expect(
      isDevinSessionLockedError({
        message: "Session 'pointy-ketch' is already open in another process.",
      }),
    ).toBe(true);
  });

  it("leaves every other failure alone", () => {
    expect(isDevinSessionLockedError({ code: -32602 })).toBe(false);
    expect(isDevinSessionLockedError({ message: "boom" })).toBe(false);
    expect(isDevinSessionLockedError(undefined)).toBe(false);
    expect(isDevinSessionLockedError(null)).toBe(false);
  });

  it("survives a self-referential cause chain", () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(isDevinSessionLockedError(looped)).toBe(false);
  });
});

describe("isDevinSessionLoadFailure", () => {
  // The timeout carries no error code, so the method name is the only signal,
  // and it arrives wrapped by the runtime rather than at the top level.
  it("recognises a load failure however it is reported", () => {
    expect(isDevinSessionLoadFailure({ method: "session/load" })).toBe(true);
    expect(isDevinSessionLoadFailure({ cause: { method: "session/load" } })).toBe(true);
    expect(
      isDevinSessionLoadFailure({
        message: "ACP transport operation call-rpc failed for method session/load.",
      }),
    ).toBe(true);
    expect(
      isDevinSessionLoadFailure({
        detail: "session/load timed out waiting for RPC response or replay idle gap",
      }),
    ).toBe(true);
  });

  // A fresh start has no session to fall back to, so its failures must surface.
  it("does not match a failure from starting a new session", () => {
    expect(isDevinSessionLoadFailure({ method: "session/new" })).toBe(false);
    expect(isDevinSessionLoadFailure({ method: "session/prompt" })).toBe(false);
    expect(isDevinSessionLoadFailure({ message: "spawn devin ENOENT" })).toBe(false);
    expect(isDevinSessionLoadFailure(null)).toBe(false);
  });

  it("survives a self-referential cause chain", () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(isDevinSessionLoadFailure(looped)).toBe(false);
  });
});
