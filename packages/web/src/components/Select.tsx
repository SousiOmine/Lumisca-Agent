import { IconCheck, IconChevronDown } from "@tabler/icons-preact";
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/compat";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import {
  type SelectSide,
  useSelectPlacement,
} from "../hooks/useSelectPlacement.ts";

/** One choice of a [`Select`]. */
export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Secondary text under the label (an id, a host name). */
  description?: string;
}

interface SelectProps<T extends string> {
  /** Accessible name of the control. */
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Renders the control full width (forms) instead of hugging its content
   * (a row's trailing control). */
  block?: boolean;
  /**
   * Side the list would like to open on, default "below".
   *
   * It is a preference, not a placement: the room around the trigger is
   * measured on every opening (see hooks/useSelectPlacement), and a list that
   * does not fit on this side opens on the other one — a trigger near the
   * bottom of a dialog, or of the window, would otherwise have its list cut
   * off by the box that clips it.
   */
  preferredSide?: SelectSide;
  /** Leading glyph inside the trigger, before the current value (a category
   * icon). Part of the trigger so the whole control stays one click target. */
  icon?: ComponentChildren;
  /** Called when the list opens, so a caller that already has another
   * popover open can close it: two lists floating over one composer is one
   * list too many. */
  onOpen?: () => void;
}

/**
 * A dropdown drawn by the app, for choices the platform's `<select>` cannot
 * express.
 *
 * A native `<select>` popup is drawn by the OS: it is a striped list in the
 * system font, it cannot carry a description line or a check mark, and on
 * macOS it anchors away from the control. Every other list in this app (the
 * model picker, the workspace picker, the app menu) is a card of rows with
 * the current choice marked, and a settings screen that mixes the two reads
 * as two different applications — the language selector was the most visible
 * instance of that.
 *
 * The trigger is a normal control of the app's own shape (same height,
 * border, radius and chevron as the pickers), and the list is the same card
 * as `.app-menu`: surface, hairline border, low wide shadow, rows highlighted
 * with `--surface-3`, the current row marked with a check. It is anchored to
 * the trigger on the side the room allows (`preferredSide`, then a
 * measurement: hooks/useSelectPlacement), so neither a dialog's bottom edge
 * nor the window's cuts it.
 */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  block = false,
  preferredSide = "below",
  icon,
  onOpen,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useClickOutside(root, () => setOpen(false), open, { onScroll: true });
  const placement = useSelectPlacement(
    trigger,
    list,
    open,
    preferredSide,
    options.length,
  );

  const current = options.find((option) => option.value === value);

  return (
    <div className={`select${block ? " block" : ""}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`select-trigger${open ? " open" : ""}`}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          onOpen?.();
          setOpen(true);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
      >
        {icon !== undefined && <span className="select-icon">{icon}</span>}
        <span className="select-value">{current?.label ?? value}</span>
        <span className={`select-chevron${open ? " open" : ""}`}>
          <IconChevronDown size={14} />
        </span>
      </button>

      {open && (
        <div
          ref={list}
          className="select-popover"
          data-placement={placement.side}
          style={
            placement.maxHeight === null
              ? undefined
              : { maxHeight: `${placement.maxHeight}px` }
          }
          role="listbox"
          aria-label={label}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`select-option${
                option.value === value ? " selected" : ""
              }`}
              onClick={() => {
                setOpen(false);
                if (option.value !== value) onChange(option.value);
              }}
            >
              <span className="select-option-body">
                <span className="select-option-label">{option.label}</span>
                {option.description !== undefined && (
                  <span className="select-option-desc">
                    {option.description}
                  </span>
                )}
              </span>
              {option.value === value && (
                <IconCheck size={14} className="select-check" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
