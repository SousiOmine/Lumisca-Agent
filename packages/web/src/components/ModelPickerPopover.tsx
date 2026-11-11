import { createPortal, type RefObject, useRef } from "preact/compat";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import { usePopoverPlacement } from "../hooks/usePopoverPlacement.ts";
import type { ModelInfo } from "../types.ts";
import { ModelPicker } from "./ModelPicker.tsx";

export interface ModelPickerPopoverProps {
  /** The control the panel is placed against: it must be on screen while
   * `open`, because the placement is measured from its rectangle. */
  anchor: RefObject<HTMLButtonElement | null>;
  open: boolean;
  /** The model in effect, or null when the caller's subject has none. */
  value: { provider: string; modelId: string } | null;
  onSelect: (provider: string, modelId: string, info?: ModelInfo) => void;
  /** Close it (a pick, an outside click, Escape, window blur). */
  onClose: () => void;
  /** Offer the row that opens the provider settings. Omitted where there is
   * no settings screen to reach from that dialog (see ModelPicker). */
  onOpenSettings?: () => void;
  imageOnly?: boolean;
}

/**
 * The model picker as a dialog opens it: a panel portaled to the body, placed
 * against the button that asked for it and limited to the room that is there
 * (hooks/usePopoverPlacement.ts).
 *
 * Portaled because a dialog scrolls its own content (`overflow-y: auto` on
 * `.modal`, and the settings page scrolls its body): inside the dialog the
 * panel would be clipped by it. Fixed, because the dialog cannot move while
 * the picker is open and the trigger's position is the only thing the panel
 * needs to know.
 *
 * One component for every dialog, so the settings' model rows and the agent
 * edit dialog open the same picker the same way. A scroll does not close it:
 * the placement follows the trigger, and closing on scroll would undo that.
 */
export function ModelPickerPopover(props: ModelPickerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  useClickOutside(popoverRef, props.onClose, props.open, {
    onBlur: true,
    within: props.anchor,
  });
  const placement = usePopoverPlacement(props.anchor, props.open, "below");
  if (!props.open || placement === null) return null;
  return createPortal(
    <div
      className="mp-popover mp-popover-dialog"
      style={placement.style}
      ref={popoverRef}
    >
      <ModelPicker
        value={props.value}
        imageOnly={props.imageOnly}
        onClose={props.onClose}
        onSelect={props.onSelect}
        onOpenSettings={props.onOpenSettings}
      />
    </div>,
    document.body,
  );
}
