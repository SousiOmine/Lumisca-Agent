import { type Icon, IconPlus } from "@tabler/icons-preact";
import { useRef, useState } from "preact/compat";
import { useClickOutside } from "../hooks/useClickOutside.ts";

/** One row: what it says, what it draws, and what picking it does. The
 * action is built by the composer, which is the only side that knows how to
 * open its own picker or reach into its own field. */
export interface ComposerAttachAction {
  id: string;
  label: string;
  icon: Icon;
  run: () => void;
}

/** The rows of the plus menu, without the trigger (the open state and the
 * click-outside listener belong to the trigger). Split out so the markup a
 * stylesheet and a screen reader contract can be drawn in a test. */
export function AttachMenuPanel({
  actions,
  onSelect,
}: {
  actions: readonly ComposerAttachAction[];
  onSelect: (action: ComposerAttachAction) => void;
}) {
  return (
    <div className="attach-popover" role="menu">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          className="attach-item"
          // The rows take the focus (no mousedown suppression, unlike the
          // palette popovers, which live off the textarea's caret): a reader
          // who cannot aim opens the menu with the button and Tab-Enters the
          // row they want.
          onClick={() => onSelect(action)}
        >
          <action.icon size={14} className="attach-item-icon" />
          <span className="attach-item-label">{action.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The composer's left-hand control: a plus that opens what can be put into
 * the message (a file, a command, a workspace path).
 *
 * It replaces the paperclip, which opened the file picker directly and so
 * could only ever say one thing. The menu is the only way to reach any of
 * these on a phone (no drag, nothing to paste), which is why the trigger
 * stays a full-size square in the field's row.
 */
export function ComposerAttachMenu({
  label,
  actions,
}: {
  /** The trigger's name (tooltip and accessible name). */
  label: string;
  actions: readonly ComposerAttachAction[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, () => setOpen(false), open);

  return (
    <div className="input-attach-slot" ref={rootRef}>
      <button
        type="button"
        className="icon-btn input-attach"
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
      >
        <IconPlus size={15} />
      </button>
      {open && (
        <AttachMenuPanel
          actions={actions}
          onSelect={(action) => {
            setOpen(false);
            action.run();
          }}
        />
      )}
    </div>
  );
}
