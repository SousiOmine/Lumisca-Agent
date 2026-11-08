import { useRef, useState } from "preact/compat";
import { DEFAULT_MODEL_KEY, parseModelPreference } from "@lumisca/core/shared";
import { api } from "../../api.ts";
import { useT } from "../../i18n.ts";
import {
  errorText,
  setModelThinkingLevel,
  useProviderModels,
} from "../../providers.ts";
import { useSetting } from "../../settingsStore.ts";
import type {
  StellaAgent,
  StellaAgentSummary,
  ThinkingLevel,
} from "../../types.ts";
import { Modal } from "../Modal.tsx";
import { Field } from "../Field.tsx";
import { ModelPickerPopover } from "../ModelPickerPopover.tsx";
import { ThinkingLevelSelect } from "../ThinkingLevelSelect.tsx";
import { AgentAvatar } from "./AgentAvatar.tsx";

export interface AgentEditDialogProps {
  agent: StellaAgentSummary;
  /** Called with the row the server answered, so the caller can put it back
   * into its list without re-reading everything. */
  onChanged: (agent: StellaAgent) => void;
  onClose: () => void;
}

/** The picture the dialog is about to save. `unchanged` sends no `icon` at
 * all (the server leaves the stored one alone), `cleared` sends null, and
 * `new` carries what the browser read from the picked file. */
type IconChoice =
  | { kind: "unchanged" }
  | { kind: "cleared" }
  | { kind: "new"; data: string; mimeType: string };

/** A model, as one comparable value (the picker's own pair). */
type ModelChoice = { provider: string; modelId: string };

/**
 * Edit what an agent is CALLED, what it LOOKS like, and which model its
 * conversation runs on: what the user chose for it.
 *
 * One dialog and one save, because they are one decision ("make this agent
 * mine") and the sidebar's row shows the first two at once: two dialogs would
 * ask the same question twice, and two requests would leave a rename and a
 * picture that disagree whenever one of them failed.
 *
 * The model is here because the conversation is not: choosing what an agent
 * runs on must not require opening a conversation first, and the settings
 * dialog could only offer it while one was open. Unset means the app's
 * default model (see the model settings), so an agent made without a choice
 * follows that instead of pinning whatever was current that day.
 *
 * What is NOT here is the role: it is the instruction the agent works from,
 * fixed at creation and baked into the session's system prompt (a change
 * would not reach a conversation that already exists). Editing it here would
 * offer a control that silently does nothing to the agent that is running.
 *
 * The picture is previewed at the size the header draws it, using the same
 * component: choosing a file is not a commit (the save is), so what is shown
 * until then is what saving will produce.
 */
export function AgentEditDialog(
  { agent, onChanged, onClose }: AgentEditDialogProps,
) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  /** The button the model picker is placed against (it is portaled to the
   * body, so the panel needs the trigger's rectangle, not its parent). */
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const [name, setName] = useState(agent.name);
  const [icon, setIcon] = useState<IconChoice>({ kind: "unchanged" });
  /** The model the dialog would save, or null for the default model. Chosen
   * here (not sent on pick) so the dialog keeps its one save: the pair is a
   * field like the name, and Cancel leaves the agent as it was. */
  const [model, setModel] = useState<ModelChoice | null>(agent.model);
  const [picking, setPicking] = useState(false);
  /** The thinking level this dialog just set, keyed by model. The catalog's
   * copy is stale until its next refetch, so this keeps the control where the
   * user left it without pretending the stored value changed. */
  const [level, setLevel] = useState<
    { key: string; level: ThinkingLevel } | null
  >(null);
  const [savingLevel, setSavingLevel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog's own exit (see Modal): a successful save leaves through it,
  // so the sheet is not removed mid-write.
  const closeRef = useRef<(after?: () => void) => void>(() => {});

  // Trimmed here as well as on the server: the button's enabled state has to
  // answer "would this be accepted?", and a name of spaces is not a name.
  const trimmed = name.trim();
  const canSave = !busy && trimmed.length > 0;

  // The default model, for the "unset" row: naming it is the difference
  // between "uses the default" and knowing what that is. Undefined when the
  // setting is unset or the settings have not loaded — the row then says
  // only that it follows the default.
  const defaultModel = parseModelPreference(useSetting(DEFAULT_MODEL_KEY));

  // The model actually in effect: the draft, or the default it falls back
  // to. Its thinking select is the one to show — the level belongs to the
  // model, so it is the same control the composer and the model settings
  // offer for that model.
  const { modelsByProvider } = useProviderModels();
  const effective = model ?? defaultModel ?? null;
  const info = effective === null
    ? undefined
    : modelsByProvider.get(effective.provider)?.find((m) =>
      m.id === effective.modelId
    );
  const levelKey = effective === null
    ? ""
    : `${effective.provider}/${effective.modelId}`;
  // The levels the model in effect supports: more than one is a choice worth
  // showing (a model with only "off" has nothing to choose).
  const supportedLevels = info?.thinkingLevels ?? [];

  const choose = async (file: File) => {
    setError(null);
    try {
      // The same envelope the composer's images travel in: a data URL, which
      // the route strips back to base64. Read as text rather than as bytes so
      // the payload reaches the server in the shape every image endpoint
      // already takes.
      setIcon({
        kind: "new",
        data: await readAsDataUrl(file),
        mimeType: file.type,
      });
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  /** Persist the thinking level of the model in effect.
   *
   * Not part of the save: the level belongs to the MODEL (it applies to
   * every conversation on it), so it is written the moment the control
   * commits, exactly as the composer and the model settings do. */
  const changeLevel = async (next: ThinkingLevel) => {
    if (effective === null) return;
    setSavingLevel(true);
    setError(null);
    try {
      const stored = await setModelThinkingLevel(
        "",
        effective.provider,
        effective.modelId,
        next,
      );
      setLevel({ key: levelKey, level: stored });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSavingLevel(false);
    }
  };

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const modelChanged = model?.provider !== agent.model?.provider ||
      model?.modelId !== agent.model?.modelId;
    try {
      const updated = await api.updateStellaAgent(agent.id, {
        name: trimmed,
        ...(icon.kind === "unchanged"
          ? {}
          : icon.kind === "cleared"
          ? { icon: null }
          : { icon: { data: icon.data, mimeType: icon.mimeType } }),
        // Only what changed: an absent key leaves the stored choice alone,
        // and a model the user did not touch must not cost a rebuild of the
        // conversation.
        ...(modelChanged ? { model } : {}),
      });
      onChanged(updated);
      closeRef.current();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={busy ? () => {} : onClose}
      label={t("chat.stella.agents.editTitle", { name: agent.name })}
    >
      {(close) => {
        closeRef.current = close;
        return (
          <>
            <h2>{t("chat.stella.agents.editTitle", { name: agent.name })}</h2>
            <div className="agent-icon-field">
              <span className="agent-icon-caption">
                {t("chat.stella.agents.icon")}
              </span>
              <div className="agent-icon-row">
                <AgentAvatar
                  agentId={agent.id}
                  name={trimmed === "" ? agent.name : trimmed}
                  icon={agent.icon}
                  preview={icon.kind === "new" ? icon.data : undefined}
                  size={64}
                />
                <div className="agent-icon-text">
                  <p className="agent-icon-hint">
                    {t("chat.stella.agents.iconHint")}
                  </p>
                  <div className="agent-icon-actions">
                    {
                      /* Hidden and triggered by the button beside it: a bare
                  file input is a browser control with its own wording, and it
                  cannot be styled to sit in this dialog. */
                    }
                    <input
                      ref={inputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
                      className="agent-icon-input"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        if (file !== undefined) void choose(file);
                      }}
                    />
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy}
                      onClick={() => inputRef.current?.click()}
                    >
                      {t("chat.stella.agents.iconChoose")}
                    </button>
                    {
                      /* Offered only when there is a picture to remove —
                        the saved one, or one picked in this dialog that has
                        not been saved yet. A control that does nothing is one
                        more thing to read. */
                    }
                    {(agent.icon !== "" || icon.kind === "new") && (
                      <button
                        type="button"
                        className="btn small"
                        disabled={busy}
                        onClick={() => {
                          setIcon({ kind: "cleared" });
                          // Re-picking the same file must reach the dialog
                          // again: the input only fires on a change.
                          if (inputRef.current !== null) {
                            inputRef.current.value = "";
                          }
                        }}
                      >
                        {t("chat.stella.agents.iconReset")}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <Field label={t("chat.stella.agents.name")}>
              <input
                type="text"
                value={name}
                onInput={(event) => setName(event.currentTarget.value)}
                autoFocus
              />
            </Field>
            <div className="agent-model-field">
              <span className="agent-icon-caption">
                {t("chat.stella.agents.model")}
              </span>
              <div className="agent-model-row">
                <div className="agent-model-value">
                  {model === null
                    ? (
                      <>
                        <span>{t("chat.stella.agents.modelDefault")}</span>
                        {defaultModel !== undefined && (
                          <span className="mono">
                            {defaultModel.provider}/{defaultModel.modelId}
                          </span>
                        )}
                      </>
                    )
                    : (
                      <span className="mono">
                        {model.provider}/{model.modelId}
                      </span>
                    )}
                  {effective !== null && supportedLevels.length > 1 && (
                    <ThinkingLevelSelect
                      value={level?.key === levelKey
                        ? level.level
                        : info?.thinkingLevel ?? "off"}
                      levels={supportedLevels}
                      onChange={(next) => void changeLevel(next)}
                      disabled={busy || savingLevel}
                    />
                  )}
                </div>
                <div className="agent-model-actions">
                  <button
                    ref={modelButtonRef}
                    type="button"
                    className="btn small"
                    disabled={busy}
                    onClick={() => setPicking((open) => !open)}
                  >
                    {picking ? t("common.close") : t("common.edit")}
                  </button>
                  {model !== null && (
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy}
                      onClick={() => {
                        setModel(null);
                        setPicking(false);
                      }}
                    >
                      {t("chat.stella.agents.modelUseDefault")}
                    </button>
                  )}
                </div>
              </div>
              <p className="agent-icon-hint">
                {t("chat.stella.agents.modelHint")}
              </p>
              <ModelPickerPopover
                anchor={modelButtonRef}
                open={picking}
                value={model}
                onClose={() => setPicking(false)}
                onSelect={(provider, modelId) => {
                  setModel({ provider, modelId });
                  setPicking(false);
                }}
              />
            </div>
            {error !== null && (
              <p className="error-text" role="alert">{error}</p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => close()}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!canSave}
                onClick={() => void save()}
              >
                {busy ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </>
        );
      }}
    </Modal>
  );
}

/** Read a file as a data URL. Rejects with the reader's failure rather than
 * resolving to something the server would refuse. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Could not read the file"));
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}
