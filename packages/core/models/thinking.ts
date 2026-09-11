import { THINKING_LEVEL_ORDER, type ThinkingLevel } from "../shared/mod.ts";

/** Structural subset of pi-ai's Model: everything the level helpers need. */
export interface ThinkingModel {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" &&
    (THINKING_LEVEL_ORDER as readonly string[]).includes(value);
}

/**
 * The thinking levels a model actually supports. Mirrors pi-ai's
 * getSupportedThinkingLevels (dist/models.js): non-reasoning models only
 * support "off"; thinkingLevelMap entries mapped to null are unsupported;
 * "xhigh"/"max" require an explicit map entry (provider defaults never
 * extend that far). pi-ai does not export the function, so the logic is
 * re-implemented here and kept in sync by tests.
 */
export function getSupportedThinkingLevels(
  model: ThinkingModel | undefined,
): ThinkingLevel[] {
  if (!model?.reasoning) return ["off"];
  return THINKING_LEVEL_ORDER.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * The nearest level to `level` that `model` supports (mirrors pi-ai's
 * clampThinkingLevel): the closest supported level at or above the request,
 * else the closest one below. Unknown levels fall back to the model's
 * strongest supported level; every model supports at least "off", so the
 * result is always a valid level.
 */
export function clampThinkingLevel(
  model: ThinkingModel | undefined,
  level: ThinkingLevel,
): ThinkingLevel {
  const available = getSupportedThinkingLevels(model);
  if (available.includes(level)) return level;
  const requestedIndex = THINKING_LEVEL_ORDER.indexOf(level);
  if (requestedIndex === -1) return available[available.length - 1] ?? "off";
  for (let i = requestedIndex; i < THINKING_LEVEL_ORDER.length; i++) {
    const candidate = THINKING_LEVEL_ORDER[i]!;
    if (available.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = THINKING_LEVEL_ORDER[i]!;
    if (available.includes(candidate)) return candidate;
  }
  return "off";
}
