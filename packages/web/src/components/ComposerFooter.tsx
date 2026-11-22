import { IconPlayerStop } from "@tabler/icons-preact";
import type { ReactNode } from "preact/compat";
import { useRef, useState } from "preact/hooks";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import { usePopoverPlacement } from "../hooks/usePopoverPlacement.ts";
import { useT } from "../i18n.ts";
import type { ModelInfo, ThinkingLevel } from "../types.ts";
import { type ComposerModel, ComposerModelBar } from "./ComposerModelBar.tsx";
import {
  ContextUsageCard,
  type ContextUsageData,
  ContextUsageTrigger,
} from "./ContextUsage.tsx";

/**
 * The row under the field: what the message will be sent with (the model, and
 * the meter for how full the context is) and the way to send it.
 *
 * It owns the two popovers that hang off that row and the rule between them
 * (opening one closes the other, and a click outside closes both). They were
 * state in Composer.tsx, where they had nothing to do with the text: the
 * measurement of the trigger and the portal into `document.body` belong to
 * the row the trigger sits on.
 *
 * The composer itself keeps no state about the footer, so a picker closed by
 * a click elsewhere closes here.
 */
export function ComposerFooter({
  modelBar,
  model,
  peerId,
  thinkingLevel,
  thinkingLevels,
  onModelSelect,
  onThinkingLevelChange,
  onOpenSettings,
  contextUsage,
  contextWarnRatio,
  onAbort,
  onSubmit,
  submitLabel,
  submitIcon: SubmitIcon,
  submitIconOnly,
  submitDisabled,
}: {
  /** `"none"` draws no model line at all (a stella conversation). */
  modelBar: "picker" | "none";
  model: ComposerModel | null;
  peerId?: string;
  thinkingLevel?: ThinkingLevel;
  thinkingLevels?: ThinkingLevel[];
  onModelSelect: (provider: string, modelId: string, info?: ModelInfo) => void;
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  onOpenSettings?: () => void;
  /** Context usage for the meter + popover (undefined hides it: the session
   * has no assistant usage yet). */
  contextUsage?: ContextUsageData;
  /** Where the meter's bar turns amber (see shared/context-usage.ts). */
  contextWarnRatio?: number;
  onAbort?: () => void;
  onSubmit: () => void;
  submitLabel: string;
  /** Optional Tabler icon shown before the submit label. */
  submitIcon?: (props: { size?: string | number }) => ReactNode;
  /** Icon-only submit: the label becomes the accessible name and tooltip. */
  submitIconOnly?: boolean;
  submitDisabled?: boolean;
}) {
  const t = useT();
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showCtx, setShowCtx] = useState(false);
  // The pickers close on outside click and Escape, like every other
  // dropdown (the refs wrap the trigger button + popover, so toggling the
  // trigger keeps working). The model popover is portaled to the body — the
  // chat pane clips its overflowing descendants, and the composer it hangs
  // over is the last thing inside that pane — so the portal is handed in as a
  // second "inside": a click on the popover is not a click outside.
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const modelPlacement = usePopoverPlacement(modelPickerRef, showModelPicker);
  const ctxRef = useRef<HTMLDivElement>(null);
  useClickOutside(
    modelPickerRef,
    () => setShowModelPicker(false),
    showModelPicker,
    { within: modelPopoverRef },
  );
  useClickOutside(ctxRef, () => setShowCtx(false), showCtx);

  return (
    <div className="input-row">
      <ComposerModelBar
        mode={modelBar}
        model={model}
        peerId={peerId}
        thinkingLevel={thinkingLevel}
        thinkingLevels={thinkingLevels}
        onModelSelect={onModelSelect}
        onThinkingLevelChange={onThinkingLevelChange}
        onOpenSettings={onOpenSettings}
        open={showModelPicker}
        onOpenChange={(next) => {
          setShowModelPicker(next);
          if (next) setShowCtx(false);
        }}
        triggerRef={modelPickerRef}
        popoverRef={modelPopoverRef}
        placement={modelPlacement}
      />
      <div className="input-actions">
        {contextUsage !== undefined && (
          <div className="ctx-wrap" ref={ctxRef}>
            <ContextUsageTrigger
              summary={contextUsage.summary}
              contextWindow={contextUsage.contextWindow}
              warnRatio={contextWarnRatio}
              open={showCtx}
              onToggle={() => {
                setShowCtx((o) => !o);
                setShowModelPicker(false);
              }}
            />
            {showCtx && (
              <ContextUsageCard
                summary={contextUsage.summary}
                contextWindow={contextUsage.contextWindow}
                warnRatio={contextWarnRatio}
              />
            )}
          </div>
        )}
        {onAbort && (
          <button
            type="button"
            className="btn danger"
            onClick={onAbort}
            aria-label={t("chat.composer.stop")}
            title={t("chat.composer.stop")}
          >
            <IconPlayerStop size={14} />
          </button>
        )}
        <button
          type="button"
          className={`btn primary${submitIconOnly ? "" : " btn-with-label"}`}
          onClick={onSubmit}
          disabled={submitDisabled}
          aria-label={submitIconOnly ? submitLabel : undefined}
          title={submitIconOnly ? submitLabel : undefined}
        >
          {SubmitIcon && <SubmitIcon size={14} />}
          {!submitIconOnly && submitLabel}
        </button>
      </div>
    </div>
  );
}
