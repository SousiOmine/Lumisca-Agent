import { useRef, useState } from "preact/compat";
import { IconCheck, IconChevronDown } from "@tabler/icons-preact";
import { useClickOutside } from "../hooks/useClickOutside.ts";

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
 * with `--surface-3`, the current row marked with a check. It is anchored
 * under the trigger and right-aligned when it opens near the window's right
 * edge, so it never leaves the viewport.
 */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  block = false,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useClickOutside(root, () => setOpen(false), open, { onScroll: true });

  const current = options.find((option) => option.value === value);

  return (
    <div className={`select${block ? " block" : ""}`} ref={root}>
      <button
        type="button"
        className={`select-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((shown) => !shown)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
      >
        <span className="select-value">{current?.label ?? value}</span>
        <span className={`select-chevron${open ? " open" : ""}`}>
          <IconChevronDown size={14} />
        </span>
      </button>

      {open && (
        <div className="select-popover" role="listbox" aria-label={label}>
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
