import type { PiModel, PiThinkingLevel } from "./rpc-types.js";

/** Canonical Pi thinking level order, lowest effort first. */
export const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Standard levels use the provider default mapping when `thinkingLevelMap` omits them. */
const PI_EXTENDED_THINKING_LEVELS: ReadonlySet<PiThinkingLevel> = new Set(["xhigh", "max"]);

export function isPiThinkingLevel(value: string | null | undefined): value is PiThinkingLevel {
  return PI_THINKING_LEVELS.includes(value as PiThinkingLevel);
}

export function normalizePiThinkingOption(
  value: string | null | undefined,
): PiThinkingLevel | null {
  if (!value) {
    return null;
  }
  return isPiThinkingLevel(value) ? value : null;
}

/**
 * Pi-compatible supported-level semantics for a model's `thinkingLevelMap`:
 * - a `null` entry marks the level unsupported (hidden/skipped/clamped away);
 * - a string entry marks the level supported;
 * - an omitted entry keeps standard levels (off..high) on the provider default
 *   mapping while extended levels (xhigh, max) stay unsupported.
 * A model without reasoning support only exposes "off" (matching Pi's
 * `get_available_thinking_levels`). An unknown model (no metadata yet) leaves
 * every level available so we never clamp without evidence.
 */
export function supportedPiThinkingLevels(model: PiModel | null | undefined): PiThinkingLevel[] {
  if (!model) {
    return [...PI_THINKING_LEVELS];
  }
  if (!model.reasoning) {
    return ["off"];
  }
  const map = model.thinkingLevelMap;
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) {
      return false;
    }
    if (typeof mapped === "string") {
      return true;
    }
    return !PI_EXTENDED_THINKING_LEVELS.has(level);
  });
}

/**
 * Clamp a requested level to the supported set: prefer the nearest supported
 * level at or below the request, then the nearest above (for models where low
 * levels such as "off" cannot be selected). Returns the request unchanged when
 * nothing is supported so the runtime stays the final authority.
 */
export function clampPiThinkingLevel(
  level: PiThinkingLevel,
  supported: readonly PiThinkingLevel[],
): PiThinkingLevel {
  if (supported.includes(level)) {
    return level;
  }
  const index = PI_THINKING_LEVELS.indexOf(level);
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const candidateLevel = PI_THINKING_LEVELS[candidate]!;
    if (supported.includes(candidateLevel)) {
      return candidateLevel;
    }
  }
  for (let candidate = index + 1; candidate < PI_THINKING_LEVELS.length; candidate += 1) {
    const candidateLevel = PI_THINKING_LEVELS[candidate]!;
    if (supported.includes(candidateLevel)) {
      return candidateLevel;
    }
  }
  return level;
}
