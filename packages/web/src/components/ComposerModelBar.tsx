import { IconChevronRight } from "@tabler/icons-preact";
import { createPortal, type RefObject } from "preact/compat";
import type { PopoverPlacement } from "../hooks/usePopoverPlacement.ts";
import { useT } from "../i18n.ts";
import type { ModelInfo, ThinkingLevel } from "../types.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { ThinkingLevelSelect } from "./ThinkingLevelSelect.tsx";

/** A model as the composer's row names it. */
export interface ComposerModel {
  provider: string;
  modelId: string;
}

export interface ComposerModelBarProps {
  /** `"none"` draws nothing (a stella conversation has no model row). */
  mode: "none" | "picker";
  model: ComposerModel | null;
  peerId?: string;
  thinkingLevel?: ThinkingLevel;
  thinkingLevels?: ThinkingLevel[];
  onModelSelect: (provider: string, modelId: string, info?: ModelInfo) => void;
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  onOpenSettings?: () => void;

  // --- state the composer owns (the popovers share it) ---------------------

  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trigger, which the placement and click-outside hooks measure. */
  triggerRef: RefObject<HTMLDivElement | null>;
  /** The portaled picker, which those hooks treat as "inside". */
  popoverRef: RefObject<HTMLDivElement | null>;
  /** Where the picker goes (see hooks/usePopoverPlacement). Null while it
   * has not measured yet. */
  placement: PopoverPlacement | null;
}

/**
 * The row under the composer that names the session's model and its thinking
 * strength, as two controls.
 *
 * They were one button with the level written beside the model id, so
 * changing the strength opened the model picker — a panel the size of a
 * catalogue for a value with four choices. The model is a pill of its own and
 * the strength an app-drawn dropdown beside it (the same control the
 * language setting uses, components/Select.tsx), each opening only what it
 * names.
 *
 * Split out of Composer.tsx: the trigger, the portal and the placement
 * plumbing have nothing to do with typing, and they were the only part of
 * the composer that reached into `document.body` (the picker is a portal so
 * a narrow layout can size it against the viewport, see
 * hooks/usePopoverPlacement).
 *
 * The picker closes on a pick (the panel no longer has a second pane that
 * follows the new model). The strength's list closes on a choice too; opening
 * it closes the model panel, because two floating lists over one footer is
 * one too many.
 */
export function ComposerModelBar({
  mode,
  model,
  peerId,
  thinkingLevel,
  thinkingLevels,
  onModelSelect,
  onThinkingLevelChange,
  onOpenSettings,
  open,
  onOpenChange,
  triggerRef,
  popoverRef,
  placement,
}: ComposerModelBarProps) {
  const t = useT();
  if (mode === "none") return null;
  // Only models that can actually think (more than just "off") get the
  // control, and only where the caller can persist a change.
  const levels = thinkingLevels ?? [];
  const canThink = levels.length > 1 && onThinkingLevelChange !== undefined;

  return (
    <div className="model-switch-bar" ref={triggerRef}>
      <button
        type="button"
        className="model-switch"
        onClick={() => onOpenChange(!open)}
        title={t("chat.composer.modelSwitchTitle")}
      >
        <span
          className="live-dot"
          style={{ background: "var(--text-faint)", width: 6, height: 6 }}
        />
        <span className="mono">
          {model
            ? `${model.provider}/${model.modelId}`
            : t("chat.composer.modelSelect")}
        </span>
        <span className={`chevron${open ? " open" : ""}`}>
          <IconChevronRight size={13} />
        </span>
      </button>
      {canThink && (
        <ThinkingLevelSelect
          value={thinkingLevel ?? "off"}
          levels={levels}
          onChange={(level) => onThinkingLevelChange?.(level)}
          preferredSide="above"
          onOpen={() => {
            if (open) onOpenChange(false);
          }}
        />
      )}
      {open &&
        placement !== null &&
        createPortal(
          <div
            className="mp-popover model-popover"
            ref={popoverRef}
            style={placement.style}
          >
            <ModelPicker
              value={model}
              peerId={peerId}
              onClose={() => onOpenChange(false)}
              onSelect={(provider, modelId, info) => {
                onModelSelect(provider, modelId, info);
              }}
              onOpenSettings={() => {
                onOpenChange(false);
                onOpenSettings?.();
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
