import { useRef, useState } from "preact/compat";
import { api } from "../../api.ts";
import { useT } from "../../i18n.ts";
import { errorText } from "../../providers.ts";
import { AGENT_ICON_FORMATS, MAX_AGENT_ICON_BYTES } from "@lumisca/core/shared";
import type { StellaAgent } from "../../types.ts";
import { Modal } from "../Modal.tsx";
import { Field } from "../Field.tsx";
import { AgentAvatar } from "./AgentAvatar.tsx";

export interface AgentEditDialogProps {
  agent: StellaAgent;
  /** Called with the row the server answered, so the caller can put it back
   * into its list without re-reading everything. */
  onChanged: (agent: StellaAgent) => void;
  onClose: () => void;
}

/** MB with one decimal. The cap is half a megabyte, so a user reads
 * "0.5 MB" rather than a six-digit byte count. */
function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)} MB`;
}

/** The picture the dialog is about to save. `unchanged` sends no `icon` at
 * all (the server leaves the stored one alone), `cleared` sends null, and
 * `new` carries what the browser read from the picked file. */
type IconChoice =
  | { kind: "unchanged" }
  | { kind: "cleared" }
  | { kind: "new"; data: string; mimeType: string };

/**
 * Edit what an agent is CALLED and what it LOOKS like: the two things the
 * user chose for it, and the only two that can change.
 *
 * One dialog and one save, because they are one decision ("make this agent
 * mine") and the sidebar's row shows both at once: two dialogs would ask the
 * same question twice, and two requests would leave a rename and a picture
 * that disagree whenever one of them failed.
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
  const [name, setName] = useState(agent.name);
  const [icon, setIcon] = useState<IconChoice>({ kind: "unchanged" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog's own exit (see Modal): a successful save leaves through it,
  // so the sheet is not removed mid-write.
  const closeRef = useRef<(after?: () => void) => void>(() => {});

  // Trimmed here as well as on the server: the button's enabled state has to
  // answer "would this be accepted?", and a name of spaces is not a name.
  const trimmed = name.trim();
  const canSave = !busy && trimmed.length > 0;

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

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateStellaAgent(agent.id, {
        name: trimmed,
        ...(icon.kind === "unchanged"
          ? {}
          : icon.kind === "cleared"
          ? { icon: null }
          : { icon: { data: icon.data, mimeType: icon.mimeType } }),
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
    <Modal onClose={busy ? () => {} : onClose}>
      {(close) => {
        closeRef.current = close;
        return (
          <>
            <h2>{t("chat.stella.agents.editTitle", { name: agent.name })}</h2>
            <Field label={t("chat.stella.agents.name")}>
              <input
                type="text"
                value={name}
                onInput={(event) => setName(event.currentTarget.value)}
                autoFocus
              />
            </Field>
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
                    {t("chat.stella.agents.iconHint", {
                      formats: AGENT_ICON_FORMATS,
                      size: megabytes(MAX_AGENT_ICON_BYTES),
                    })}
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
