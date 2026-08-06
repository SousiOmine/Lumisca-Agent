import { type KeyboardEvent, useState } from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { ModelPicker } from "./ModelPicker.tsx";

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
  onModelSelect: (provider: string, modelId: string) => void;
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
          {showModelPicker && (
            <div className="model-popover">
              <ModelPicker
                value={model}
                onSelect={(provider, modelId) => {
                  onModelSelect(provider, modelId);
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
