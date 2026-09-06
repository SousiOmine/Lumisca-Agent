import { useEffect, useMemo, useState } from "preact/compat";
import {
  THINKING_LEVEL_LABELS,
  THINKING_LEVEL_ORDER,
} from "@lumisca/core/shared";
import type { ThinkingLevel } from "../types.ts";

interface ThinkingLevelSliderProps {
  /** Currently stored level (may be outside `levels` when the catalog
   * changed; it is clamped to the nearest supported level for display). */
  value: ThinkingLevel;
  /** Supported levels of the model, in any order (sorted internally by
   * strength). Must contain at least 2 entries; fewer renders nothing. */
  levels: ThinkingLevel[];
  /** Called once per user gesture (slider release / tick click / keyboard
   * commit), so dragging never spams the save API. */
  onCommit: (level: ThinkingLevel) => void;
  disabled?: boolean;
}

/** Vertical thinking-strength slider: a thick draggable bar whose
 * current level name is shown below it. Dragging previews live and
 * commits on release, so the save API is never spammed. */
export function ThinkingLevelSlider({
  value,
  levels,
  onCommit,
  disabled,
}: ThinkingLevelSliderProps) {
  // Strength order, regardless of the catalog's array order.
  const sorted = useMemo(
    () =>
      [...levels].sort(
        (a, b) =>
          THINKING_LEVEL_ORDER.indexOf(a) - THINKING_LEVEL_ORDER.indexOf(b),
      ),
    [levels],
  );

  // Index of the stored value, clamped to the nearest supported level
  // when the stored value itself is unsupported (e.g. catalog changed).
  const committedIndex = useMemo(() => {
    const at = sorted.indexOf(value);
    if (at !== -1) return at;
    const order = THINKING_LEVEL_ORDER.indexOf(value);
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < sorted.length; i++) {
      const dist = Math.abs(THINKING_LEVEL_ORDER.indexOf(sorted[i]!) - order);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }, [sorted, value]);

  // Drag preview: updated on every input event, committed on change
  // (release). Cleared whenever the stored value settles from outside.
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => {
    setDraft(null);
  }, [value, levels]);

  if (sorted.length < 2) return null;

  const shown = draft ?? committedIndex;
  const shownLevel = sorted[shown]!;
  const max = sorted.length - 1;
  // Fraction 0..1 for the fill height (a bare number, so CSS can compute
  // `calc((100% - travel) * var(--tls-fill))` — percentages cannot multiply
  // lengths, plain numbers can).
  const fillFraction = max === 0 ? 1 : shown / max;

  const commit = (index: number) => {
    setDraft(null);
    const level = sorted[index]!;
    if (level !== value) onCommit(level);
  };

  return (
    <div className="tls">
      <div className="tls-body">
        <div
          className="tls-track-wrap"
          style={{ "--tls-fill": `${fillFraction}` } as Record<string, string>}
        >
          <div className="tls-fill" aria-hidden="true" />
          <input
            type="range"
            className="tls-range"
            aria-label="思考強度"
            aria-valuetext={THINKING_LEVEL_LABELS[shownLevel]}
            min={0}
            max={max}
            step={1}
            value={shown}
            disabled={disabled}
            onInput={(e) => setDraft(Number(e.currentTarget.value))}
            onChange={(e) => commit(Number(e.currentTarget.value))}
          />
        </div>
      </div>
      <div className="tls-value" key={shownLevel} aria-live="polite">
        {THINKING_LEVEL_LABELS[shownLevel]}
      </div>
    </div>
  );
}
