import { createPortal, type RefObject, useRef } from "preact/compat";
import type { ModelInfo, ThinkingLevel } from "../types.ts";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import { usePopoverPlacement } from "../hooks/usePopoverPlacement.ts";
import { ModelPicker } from "./ModelPicker.tsx";

export interface ModelPickerPopoverProps {
  /** The control the panel is placed against: it must be on screen while
   * `open`, because the placement is measured from its rectangle. */
  anchor: RefObject<HTMLButtonElement | null>;
  open: boolean;
  /** The model in effect, or null when the caller's subject has none (the
   * picker then opens on the provider list). */
  value: { provider: string; modelId: string } | null;
  onSelect: (provider: string, modelId: string, info?: ModelInfo) => void;
  /** Close it (outside click, Escape, window blur, or the panel's own ×). */
  onClose: () => void;
  /** Offer the link to the provider settings. Omitted where there is no
   * settings screen to reach from that dialog (see ModelPicker). */
  onOpenSettings?: () => void;
  imageOnly?: boolean;
  thinkingValue?: ThinkingLevel;
  thinkingLevels?: ThinkingLevel[];
  onThinkingChange?: (level: ThinkingLevel) => void;
  thinkingDisabled?: boolean;
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
        stacked={!placement.panes}
        roomHeight={placement.height}
        onClose={props.onClose}
        onSelect={props.onSelect}
        onOpenSettings={props.onOpenSettings}
        thinkingValue={props.thinkingValue}
        thinkingLevels={props.thinkingLevels}
        onThinkingChange={props.onThinkingChange}
        thinkingDisabled={props.thinkingDisabled}
      />
    </div>,
    document.body,
  );
}
