import { describe, expect, it } from "@effect/vitest";

import { parseDevinAuthStatus, parseDevinModelsJson } from "./DevinProvider.ts";

describe("parseDevinAuthStatus", () => {
  it("reads the verdict from the text, since the exit code does not carry it", () => {
    expect(parseDevinAuthStatus("Logged in (via Devin).")).toBe(true);
    expect(
      parseDevinAuthStatus("Not logged in.\n  Credentials path: /home/u/credentials.toml"),
    ).toBe(false);
  });

  it("stays undecided rather than guessing", () => {
    expect(parseDevinAuthStatus("")).toBeNull();
    expect(parseDevinAuthStatus("error: connection refused")).toBeNull();
  });
});

describe("parseDevinModelsJson", () => {
  const payload = JSON.stringify({
    families: [
      {
        family_label: "SWE-1.6 Slow",
        slug: "swe-1.6-slow",
        aliases: [],
        variants: [{ model_uid: "swe-1-6-slow", label: "SWE-1.6 Slow" }],
      },
      {
        family_label: "Claude Opus 5",
        slug: "claude-opus-5",
        aliases: ["opus"],
        variants: [
          { model_uid: "claude-opus-5-low", label: "Claude Opus 5 Low" },
          { model_uid: "claude-opus-5-high", label: "Claude Opus 5 High" },
        ],
      },
    ],
  });

  it("keys on the family slug rather than the per-effort variants", () => {
    // Both `--model` and the ACP model option resolve against the family slug;
    // the variants are effort levels, not separate models.
    expect(parseDevinModelsJson(payload).map((model) => model.slug)).toEqual([
      "swe-1.6-slow",
      "claude-opus-5",
    ]);
  });

  it("carries the human label through for the picker", () => {
    expect(parseDevinModelsJson(payload)[0]?.name).toBe("SWE-1.6 Slow");
  });

  it("degrades to an empty catalog instead of throwing on unusable output", () => {
    expect(parseDevinModelsJson("Not logged in.")).toEqual([]);
    expect(parseDevinModelsJson("{}")).toEqual([]);
    expect(parseDevinModelsJson(JSON.stringify({ families: [{ no_slug: true }] }))).toEqual([]);
  });
});
