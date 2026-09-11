import { useCallback, useState } from "preact/compat";
import type { JSX } from "preact";

/** Props that turn a row element into a keyboard-operable disclosure. */
export interface ExpandableRowProps {
  onClick: () => void;
  onKeyDown: (event: JSX.TargetedKeyboardEvent<HTMLElement>) => void;
  role?: "button";
  tabIndex?: number;
  "aria-expanded"?: boolean;
}

export interface ExpandableRow {
  open: boolean;
  triggerProps: ExpandableRowProps;
}

/**
 * Disclosure state of a click-to-expand row (a tool call, a notification).
 * The returned props make the row a real button — `role`, `tabIndex`, and
 * Enter/Space activation — instead of a mouse-only `<div onClick>`, and are
 * shared so both rows cannot drift apart.
 *
 * `enabled` false keeps the row inert (a notification with no body has
 * nothing to disclose, so it must not claim to be a button).
 */
export function useExpandableRow(enabled = true): ExpandableRow {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => {
    if (enabled) setOpen((current) => !current);
  }, [enabled]);

  const onKeyDown = useCallback(
    (event: JSX.TargetedKeyboardEvent<HTMLElement>) => {
      if (!enabled) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      // Keydown would otherwise scroll the transcript (Space) or submit a
      // surrounding form (Enter).
      event.preventDefault();
      toggle();
    },
    [enabled, toggle],
  );

  const triggerProps: ExpandableRowProps = enabled
    ? {
      onClick: toggle,
      onKeyDown,
      role: "button",
      tabIndex: 0,
      "aria-expanded": open,
    }
    : { onClick: toggle, onKeyDown };

  return { open, triggerProps };
}
