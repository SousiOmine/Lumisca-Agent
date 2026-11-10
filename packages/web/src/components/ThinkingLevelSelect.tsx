import { useMemo } from "preact/compat";
import { IconBrain } from "@tabler/icons-preact";
import { THINKING_LEVEL_ORDER } from "@lumisca/core/shared";
import type { ThinkingLevel } from "../types.ts";
import { useT } from "../i18n.ts";
import { thinkingLevelLabel } from "../format.ts";
import type { SelectSide } from "../hooks/useSelectPlacement.ts";
import { Select } from "./Select.tsx";

export interface ThinkingLevelSelectProps {
  /** The stored level. May be outside `levels` when the catalog changed; it
   * is shown as the nearest supported level then. */
  value: ThinkingLevel;
  /** The levels the model supports. Fewer than two means there is nothing to
   * choose, and the control renders nothing at all. */
  levels: readonly ThinkingLevel[];
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
  /** Side the list would like to open on (see Select). The composer's footer
   * passes "above": it sits on the window's bottom edge. */
  preferredSide?: SelectSide;
  /** Called when the list opens, so a caller with another popover open (the
   * model picker above the same footer) can close it. */
  onOpen?: () => void;
}

/**
 * The thinking strength of the model in effect, as the app's own dropdown
 * (components/Select.tsx — the control the language setting uses).
 *
 * A separate control from the model picker because the two answer different
 * questions: the model is chosen once for a conversation, while the strength
 * is tuned while working, often more than once. A rail inside the picker
 * made every level change reopen a panel to move one value.
 */
export function ThinkingLevelSelect({
  value,
  levels,
  onChange,
  disabled = false,
  preferredSide = "below",
  onOpen,
}: ThinkingLevelSelectProps) {
  const t = useT();
  const sorted = useMemo(() => sortLevels(levels), [levels]);
  if (sorted.length < 2) return null;

  return (
    <div className="thinking-select">
      <Select
        label={t("chrome.modelPicker.thinkingStrength")}
        value={nearestLevel(sorted, value)}
        options={sorted.map((level) => ({
          value: level,
          label: thinkingLevelLabel(level, t),
        }))}
        onChange={onChange}
        disabled={disabled}
        preferredSide={preferredSide}
        onOpen={onOpen}
        icon={<IconBrain size={12} />}
      />
    </div>
  );
}

/** Strength order, regardless of the catalog's array order. */
function sortLevels(levels: readonly ThinkingLevel[]): ThinkingLevel[] {
  return [...new Set(levels)].sort(
    (a, b) => THINKING_LEVEL_ORDER.indexOf(a) - THINKING_LEVEL_ORDER.indexOf(b),
  );
}

/**
 * The supported level closest to `value`. A stored level the model no longer
 * supports (the catalog changed, another client wrote it) would leave the
 * trigger naming a choice that is not in the list; the nearest one at least
 * says what the model will do.
 */
function nearestLevel(
  sorted: readonly ThinkingLevel[],
  value: ThinkingLevel,
): ThinkingLevel {
  if (sorted.includes(value)) return value;
  const target = THINKING_LEVEL_ORDER.indexOf(value);
  let best = sorted[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of sorted) {
    const distance = Math.abs(THINKING_LEVEL_ORDER.indexOf(level) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = level;
    }
  }
  return best;
}
