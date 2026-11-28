import { errorMessage, MAX_AGENT_IDENTITY_CHARS } from "@lumisca/core/shared";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../api.ts";
import { useT } from "../../i18n.ts";
import type { StellaAgentSummary } from "../../types.ts";
import { Modal } from "../Modal.tsx";

export interface AgentIdentityDialogProps {
  agent: StellaAgentSummary;
  onClose: () => void;
}

/**
 * The agent's own text, opened from its row's menu and saved by the user.
 *
 * The identity is written by the agent itself with the `identity` tool, and
 * nothing in the app shows it: this dialog is the one place the user reads
 * the stored text, and the only place they can replace it. It is here because
 * the agent sometimes writes something wrong, or nothing at all, and the user
 * has no way to say so except by talking to it again.
 *
 * The whole text is loaded before anything is shown: a field that saves what
 * it holds must not start empty while the read is in flight, or the first
 * save would erase the note. Saving is refused until the read answers, and
 * when the text did not change (a no-op write would only move the timestamp).
 *
 * The dialog states WHEN a saved change reaches the conversation: the text is
 * fixed in the system prompt when that prompt is generated, so the open
 * conversation keeps the old one until it is reopened or compacted — the same
 * rule the agent's own tool states in its result.
 */
export function AgentIdentityDialog({
  agent,
  onClose,
}: AgentIdentityDialogProps) {
  const t = useT();
  /** What the server holds, or null until the read answers. It is what the
   * textarea starts from and what "unchanged" is compared with. */
  const [loaded, setLoaded] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog's own exit (see Modal): a successful save leaves through it,
  // so the sheet is not removed mid-write.
  const closeRef = useRef<(after?: () => void) => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void api
      .getStellaAgentIdentity(agent.id)
      .then((answer) => {
        if (cancelled) return;
        setLoaded(answer.identity);
        setText(answer.identity);
      })
      .catch((failure: unknown) => {
        // A read that failed leaves the dialog without its starting point:
        // saving is refused (see `canSave`), so an empty field cannot
        // replace a note the user never saw. Closing and opening the row's
        // menu again reads it once more.
        if (!cancelled) setError(errorMessage(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const canSave = loaded !== null && !busy && text !== loaded;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await api.setStellaAgentIdentity(agent.id, text);
      closeRef.current();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const title = t("chat.stella.agents.identityTitle", { name: agent.name });
  return (
    <Modal onClose={busy ? () => {} : onClose} width="640px" label={title}>
      {(close) => {
        closeRef.current = close;
        return (
          <>
            <h2>{title}</h2>
            <p className="agent-icon-hint">
              {t("chat.stella.agents.identityHint")}
            </p>
            <textarea
              className="agent-identity-text"
              rows={12}
              value={text}
              maxLength={MAX_AGENT_IDENTITY_CHARS}
              placeholder={t("chat.stella.agents.identityPlaceholder")}
              aria-label={t("chat.stella.agents.identityField")}
              disabled={loaded === null || busy}
              onInput={(event) => setText(event.currentTarget.value)}
              autoFocus
            />
            <p className="agent-icon-hint">
              {text.length}/{MAX_AGENT_IDENTITY_CHARS}
            </p>
            <p className="agent-icon-hint">
              {t("chat.stella.agents.identityNote")}
            </p>
            {error !== null && (
              <p className="error-text" role="alert">
                {t(
                  loaded === null
                    ? "chat.stella.agents.identityLoadFailed"
                    : "common.saveFailed",
                  { error },
                )}
              </p>
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
