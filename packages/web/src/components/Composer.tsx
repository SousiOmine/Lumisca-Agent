import { type KeyboardEvent, useState } from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { THINKING_LEVEL_LABELS } from "@lumisca/core/shared";
import { ModelPicker } from "./ModelPicker.tsx";
import type { ModelInfo, ThinkingLevel } from "../types.ts";

export interface ComposerModel {
  provider: string;
  modelId: string;
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Taller, vertically resizable textarea (new-session use). */
  large?: boolean;
  model: ComposerModel | null;
  onModelSelect: (
    provider: string,
    modelId: string,
    info?: ModelInfo,
  ) => void;
  /** Thinking level of the current model; the select appears only when the
   * model supports levels besides "off" (see thinkingLevels). */
  thinkingLevel?: ThinkingLevel;
  thinkingLevels?: ThinkingLevel[];
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  submitLabel: string;
  submitDisabled?: boolean;
  /** Show an abort button instead of submit while the agent is running. */
  onAbort?: () => void;
  onSubmit: () => void;
}

/** Shared chat input: textarea + model picker + submit, in one rounded box.
 * Enter/Shift+Enter insert a newline; Ctrl+Enter submits. */
export function Composer({
  value,
  onChange,
  onKeyDown,
  placeholder,
  autoFocus,
  large,
  model,
  onModelSelect,
  thinkingLevel,
  thinkingLevels,
  onThinkingLevelChange,
  submitLabel,
  submitDisabled,
  onAbort,
  onSubmit,
}: ComposerProps) {
  const [showModelPicker, setShowModelPicker] = useState(false);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      onSubmit();
    }
    onKeyDown?.(e);
  };

  // Only models that can actually think (more than just "off") get the
  // level selector; the options are the levels the model supports.
  const levels = thinkingLevels ?? [];
  const canThink = levels.length > 1;

  return (
    <div className="input-composer">
      <textarea
        className={`input-box${large ? " large" : ""}`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus={autoFocus}
      />
      <div className="input-row">
        <div className="model-switch-bar">
          <button
            type="button"
            className="model-switch"
            onClick={() => setShowModelPicker((o) => !o)}
            title="モデルを選択"
          >
            <span
              className="live-dot"
              style={{ background: "var(--text-faint)", width: 6, height: 6 }}
            />
            <span className="mono">
              {model ? `${model.provider}/${model.modelId}` : "モデルを選択"}
            </span>
            <span className={`chevron${showModelPicker ? " open" : ""}`}>
              <IconChevronRight size={13} />
            </span>
          </button>
          {canThink && onThinkingLevelChange && (
            <select
              className="thinking-select"
              value={thinkingLevel ?? "off"}
              title="思考強度"
              onChange={(e) =>
                onThinkingLevelChange(e.target.value as ThinkingLevel)}
            >
              {levels.map((level) => (
                <option key={level} value={level}>
                  {THINKING_LEVEL_LABELS[level]}
                </option>
              ))}
            </select>
          )}
          {showModelPicker && (
            <div className="model-popover">
              <ModelPicker
                value={model}
                onSelect={(provider, modelId, info) => {
                  onModelSelect(provider, modelId, info);
                  setShowModelPicker(false);
                }}
              />
            </div>
          )}
        </div>
        {onAbort
          ? (
            <button type="button" className="btn danger" onClick={onAbort}>
              中断
            </button>
          )
          : (
            <button
              type="button"
              className="btn primary"
              onClick={onSubmit}
              disabled={submitDisabled}
            >
              {submitLabel}
            </button>
          )}
      </div>
    </div>
  );
}
