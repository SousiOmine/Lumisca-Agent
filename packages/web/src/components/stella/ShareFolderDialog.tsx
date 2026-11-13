import { errorMessage } from "@lumisca/core/shared";
import { IconFolder } from "@tabler/icons-preact";
import { useState } from "preact/compat";
import { useT } from "../../i18n.ts";
import {
  folderName,
  loadRecentFolders,
  type RecentShareFolder,
  rememberFolder,
} from "../../share-recents.ts";
import { shellCall } from "../../shell.ts";
import { Modal } from "../Modal.tsx";
import { ShareTerms } from "./ShareList.tsx";

export interface ShareFolderDialogProps {
  /** The conversation's server-side session id: the loan is made to it, and
   * the shell passes it to the lending child unchanged. */
  sessionId: string;
  onClose: () => void;
}

/**
 * Lend a folder from this computer to the open conversation.
 *
 * The picker is the consent, so this dialog is what happens AROUND it: the
 * folder is chosen first, then the terms are read once (read-only or
 * read-write, and whether commands may run there), then "share" makes the
 * loan. Nothing is lent before that last press — a dialog that lent as soon
 * as a folder was picked would take the reader's click on a folder name for
 * agreement to everything else on the sheet.
 *
 * The recently shared folders are one step on purpose: they repeat a decision
 * the user already made, with the terms they set then. The shell still checks
 * that the folder exists before lending it.
 */
export function ShareFolderDialog({
  sessionId,
  onClose,
}: ShareFolderDialogProps) {
  const t = useT();
  const [recent] = useState<RecentShareFolder[]>(() => loadRecentFolders());
  const [selected, setSelected] = useState<RecentShareFolder | null>(null);
  // Terms start read only. A folder lent again starts from its own last
  // terms instead (see choose and lend). Commands are always allowed, so
  // there is nothing else to ask.
  const [write, setWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await shellCall<{ path: string | null }>(
        "share/pick-folder",
      );
      if (answer.path !== null) {
        const known = recent.find((entry) => entry.path === answer.path);
        setSelected({
          path: answer.path,
          name: folderName(answer.path),
          write: known?.write ?? false,
        });
        setWrite(known?.write ?? false);
      }
    } catch (failure) {
      setError(
        t("chat.stella.share.pickFailed", { error: errorMessage(failure) }),
      );
    } finally {
      setBusy(false);
    }
  };

  /** Lend one folder and leave. `close` is the dialog's own exit, so the
   * sheet does not vanish in one frame. */
  const lend = async (folder: RecentShareFolder, close: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await shellCall("share/grant", {
        sessionId,
        path: folder.path,
        write: folder.write ? "1" : "0",
      });
      rememberFolder(folder);
      close();
    } catch (failure) {
      setError(
        t("chat.stella.share.lendFailed", { error: errorMessage(failure) }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={t("chat.stella.share.title")}>
      {(close) => (
        <>
          <h2>{t("chat.stella.share.title")}</h2>
          <p className="stella-share-hint">{t("chat.stella.share.hint")}</p>

          <button
            type="button"
            className="btn stella-share-pick"
            disabled={busy}
            onClick={() => void choose()}
          >
            <IconFolder size={15} />
            {t("chat.stella.share.pick")}
          </button>

          {selected !== null && (
            <div className="stella-share-terms-panel">
              <p className="stella-share-path" title={selected.path}>
                {selected.name}
                <span className="stella-share-origin">{selected.path}</span>
              </p>
              <label className="stella-share-choice">
                <input
                  type="radio"
                  name="stella-share-write"
                  checked={!write}
                  onChange={() => setWrite(false)}
                />
                {t("chat.stella.share.readOnly")}
              </label>
              <label className="stella-share-choice">
                <input
                  type="radio"
                  name="stella-share-write"
                  checked={write}
                  onChange={() => setWrite(true)}
                />
                {t("chat.stella.share.readWrite")}
              </label>
              <p className="stella-share-note">{t("chat.stella.share.idle")}</p>
              <div className="stella-share-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() =>
                    void lend({ ...selected, write }, () => close())
                  }
                >
                  {busy
                    ? t("chat.stella.share.lending")
                    : t("chat.stella.share.lend")}
                </button>
              </div>
            </div>
          )}

          {recent.length > 0 && (
            <section className="stella-share-recent">
              <h3 className="stella-pane-section">
                {t("chat.stella.share.recent")}
              </h3>
              <ul className="stella-share-list">
                {recent.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="stella-recent-folder"
                      disabled={busy}
                      title={entry.path}
                      onClick={() => void lend(entry, () => close())}
                    >
                      <IconFolder size={15} />
                      <span className="stella-recent-name">{entry.name}</span>
                      <ShareTerms write={entry.write} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {error !== null && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {/* Always here, not only in the decision: on a phone the dialog
           * fills the screen, so the backdrop is not a way out. */}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => close()}>
              {t("common.close")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
