import { describe, expect, test } from "vitest";

import type { PiModel } from "./rpc-types.js";
import { clampPiThinkingLevel, supportedPiThinkingLevels } from "./thinking-levels.js";

function reasoningModel(overrides: Partial<PiModel> = {}): PiModel {
  return {
    provider: "openrouter",
    id: "deepseek-v4-pro",
    reasoning: true,
    ...overrides,
  };
}

describe("supportedPiThinkingLevels", () => {
  test("leaves every level available for an unknown model", () => {
    expect(supportedPiThinkingLevels(null)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("exposes only off for a model without reasoning support", () => {
    expect(supportedPiThinkingLevels(reasoningModel({ reasoning: false }))).toEqual(["off"]);
  });

  test("exposes standard levels for a reasoning model without a map", () => {
    expect(supportedPiThinkingLevels(reasoningModel())).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  test("honors map holes: null hides, string enables, omitted keeps standard levels", () => {
    expect(
      supportedPiThinkingLevels(
        reasoningModel({
          thinkingLevelMap: {
            minimal: null,
            low: null,
            medium: null,
            high: "high",
            xhigh: null,
            max: "max",
          },
        }),
      ),
    ).toEqual(["off", "high", "max"]);
  });

  test("supports models where thinking cannot be disabled", () => {
    expect(supportedPiThinkingLevels(reasoningModel({ thinkingLevelMap: { off: null } }))).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("clampPiThinkingLevel", () => {
  test("returns a supported level unchanged", () => {
    expect(clampPiThinkingLevel("medium", ["off", "medium", "high"])).toBe("medium");
  });

  test("clamps down to the nearest supported level", () => {
    expect(clampPiThinkingLevel("xhigh", ["off", "minimal", "low", "medium", "high"])).toBe("high");
    expect(clampPiThinkingLevel("medium", ["off", "high", "max"])).toBe("off");
  });

  test("clamps up when nothing lower is supported", () => {
    expect(clampPiThinkingLevel("off", ["minimal", "low", "medium", "high"])).toBe("minimal");
  });

  test("returns the request unchanged when nothing is supported", () => {
    expect(clampPiThinkingLevel("high", [])).toBe("high");
  });
});
