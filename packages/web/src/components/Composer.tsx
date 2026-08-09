import { type ComponentType, type KeyboardEvent, useState } from "react";
import {
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconPlayerStop,
} from "@tabler/icons-react";
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
  /** Optional Tabler icon shown before the submit label. */
  submitIcon?: ComponentType<{ size?: number }>;
  /** Icon-only submit: hide the label text; submitLabel is still used as
   * the accessible name and tooltip. */
  submitIconOnly?: boolean;
  submitDisabled?: boolean;
  /** Show an abort button instead of submit while the agent is running. */
  onAbort?: () => void;
  onSubmit: () => void;
  /** Peer owning the session ("" = this server). The model picker then
   * lists the PEER's models, so switching a remote session's model works
   * against the machine that runs the agent. */
  peerId?: string;
  /** Hide the model switch bar entirely (used by the draft tab when the
   * selected workspace is on another server: the session is created with
   * the peer's default model). */
  hideModelSwitch?: boolean;
  /** Open the settings modal from the model picker's "Manage models" link. */
  onOpenSettings?: () => void;
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
  submitIcon: SubmitIcon,
  submitIconOnly,
  submitDisabled,
  onAbort,
  onSubmit,
  peerId,
  hideModelSwitch,
  onOpenSettings,
}: ComposerProps) {
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showThinkingPicker, setShowThinkingPicker] = useState(false);

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
        {hideModelSwitch
          ? (
            <span className="settings-note" style={{ alignSelf: "center" }}>
              接続先サーバーの既定モデルを使用します
            </span>
          )
          : (
            <div className="model-switch-bar">
              <button
                type="button"
                className="model-switch"
                onClick={() => {
                  setShowModelPicker((o) => !o);
                  setShowThinkingPicker(false);
                }}
                title="モデルを選択"
              >
                <span
                  className="live-dot"
                  style={{
                    background: "var(--text-faint)",
                    width: 6,
                    height: 6,
                  }}
                />
                <span className="mono">
                  {model
                    ? `${model.provider}/${model.modelId}`
                    : "モデルを選択"}
                </span>
                <span className={`chevron${showModelPicker ? " open" : ""}`}>
                  <IconChevronRight size={13} />
                </span>
              </button>
              {canThink && onThinkingLevelChange && (
                <div className="thinking-control">
                  <button
                    type="button"
                    className="thinking-switch"
                    onClick={() => {
                      setShowThinkingPicker((o) => !o);
                      setShowModelPicker(false);
                    }}
                    title="思考強度"
                  >
                    <IconBrain size={13} />
                    <span>{THINKING_LEVEL_LABELS[thinkingLevel ?? "off"]}</span>
                    <span
                      className={`chevron${showThinkingPicker ? " open" : ""}`}
                    >
                      <IconChevronRight size={13} />
                    </span>
                  </button>
                  {showThinkingPicker && (
                    <div className="thinking-popover">
                      {levels.map((level) => (
                        <button
                          key={level}
                          type="button"
                          className={`thinking-option${
                            (thinkingLevel ?? "off") === level
                              ? " selected"
                              : ""
                          }`}
                          onClick={() => {
                            onThinkingLevelChange(level);
                            setShowThinkingPicker(false);
                          }}
                        >
                          <span>{THINKING_LEVEL_LABELS[level]}</span>
                          {(thinkingLevel ?? "off") === level && (
                            <IconCheck size={13} className="thinking-check" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {showModelPicker && (
                <div className="model-popover">
                  <ModelPicker
                    value={model}
                    peerId={peerId}
                    onSelect={(provider, modelId, info) => {
                      onModelSelect(provider, modelId, info);
                      setShowModelPicker(false);
                    }}
                    onOpenSettings={() => {
                      setShowModelPicker(false);
                      onOpenSettings?.();
                    }}
                  />
                </div>
              )}
            </div>
          )}
        {onAbort
          ? (
            <button type="button" className="btn danger" onClick={onAbort}>
              <IconPlayerStop size={14} />
              中断
            </button>
          )
          : (
            <button
              type="button"
              className="btn primary"
              onClick={onSubmit}
              disabled={submitDisabled}
              aria-label={submitIconOnly ? submitLabel : undefined}
              title={submitIconOnly ? submitLabel : undefined}
            >
              {SubmitIcon && <SubmitIcon size={14} />}
              {!submitIconOnly && submitLabel}
            </button>
          )}
      </div>
    </div>
  );
}
