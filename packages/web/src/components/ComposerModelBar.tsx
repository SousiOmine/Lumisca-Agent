import { createPortal, type RefObject } from "preact/compat";
import { IconBrain, IconChevronRight } from "@tabler/icons-preact";
import { ModelPicker } from "./ModelPicker.tsx";
import type { ModelInfo, ThinkingLevel } from "../types.ts";
import { thinkingLevelLabel } from "../format.ts";
import { useT } from "../i18n.ts";
import type { PopoverPlacement } from "../hooks/usePopoverPlacement.ts";

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
  onModelSelect: (
    provider: string,
    modelId: string,
    info?: ModelInfo,
  ) => void;
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
 * The row under the composer that names the session's model and opens the
 * picker.
 *
 * Split out of Composer.tsx: the trigger, the portal and the placement
 * plumbing have nothing to do with typing, and they were the only part of
 * the composer that reached into `document.body` (the picker is a portal so
 * a narrow layout can size it against the viewport, see
 * hooks/usePopoverPlacement).
 *
 * The trigger stays a button that reports what will answer: provider/model in
 * mono, the thinking level beside it when the model has levels. The picker
 * itself stays open after a selection — the thinking pane follows the newly
 * chosen model, so strength can be tuned in the same opening — and closes on
 * an outside click or Escape.
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
  // Only models that can actually think (more than just "off") get the level
  // label; the options are the levels the model supports.
  const canThink = (thinkingLevels?.length ?? 0) > 1;

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
        {canThink && (
          <span className="model-thinking-label">
            <IconBrain size={12} />
            <span>{thinkingLevelLabel(thinkingLevel ?? "off", t)}</span>
          </span>
        )}
        <span className={`chevron${open ? " open" : ""}`}>
          <IconChevronRight size={13} />
        </span>
      </button>
      {open && placement !== null && createPortal(
        <div
          className="mp-popover model-popover"
          ref={popoverRef}
          style={placement.style}
        >
          <ModelPicker
            value={model}
            peerId={peerId}
            stacked={!placement.panes}
            roomHeight={placement.height}
            onClose={() => onOpenChange(false)}
            onSelect={(provider, modelId, info) => {
              onModelSelect(provider, modelId, info);
            }}
            onOpenSettings={() => {
              onOpenChange(false);
              onOpenSettings?.();
            }}
            thinkingValue={thinkingLevel}
            thinkingLevels={thinkingLevels}
            onThinkingChange={onThinkingLevelChange}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}
