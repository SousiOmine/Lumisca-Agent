import { useRef, useState } from "preact/compat";
import {
  IconBrain,
  IconCheck,
  IconChevronRight,
} from "@tabler/icons-preact";
import { THINKING_LEVEL_LABELS } from "@lumisca/core/shared";
import type { ThinkingLevel } from "../types.ts";
import { useClickOutside } from "../hooks/useClickOutside.ts";

interface ThinkingLevelPickerProps {
  value: ThinkingLevel;
  levels: ThinkingLevel[];
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
  /** Called when the popover opens, so the parent can close its other
   * popovers (the chat input closes the model picker and usage card). */
  onOpen?: () => void;
}

/** Thinking-strength picker: a brain-icon button with a popover listing
 * the levels the model supports. Shared by the chat input (Composer) and
 * the fast-model row in settings, so both look and behave the same. */
export function ThinkingLevelPicker({
  value,
  levels,
  onChange,
  disabled,
  onOpen,
}: ThinkingLevelPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  return (
    <div className="thinking-control" ref={ref}>
      <button
        type="button"
        className="thinking-switch"
        disabled={disabled}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            onOpen?.();
            setOpen(true);
          }
        }}
        title="思考強度"
      >
        <IconBrain size={13} />
        <span>{THINKING_LEVEL_LABELS[value]}</span>
        <span className={`chevron${open ? " open" : ""}`}>
          <IconChevronRight size={13} />
        </span>
      </button>
      {open && (
        <div className="thinking-popover">
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              className={`thinking-option${
                value === level ? " selected" : ""
              }`}
              onClick={() => {
                onChange(level);
                setOpen(false);
              }}
            >
              <span>{THINKING_LEVEL_LABELS[level]}</span>
              {value === level && (
                <IconCheck size={13} className="thinking-check" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
