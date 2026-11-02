import { Modal } from "./Modal.tsx";
import { useT } from "../i18n.ts";

interface CloseTabsDialogProps {
  /** Names of the running tabs this close targets, in tab order. */
  names: string[];
  onCancel: () => void;
  /** Close the tabs and stop the running sessions (POST /close). */
  onStopAndClose: () => void;
  /** Close the tabs but let the running sessions finish on the server. */
  onKeepRunning: () => void;
}

/** The confirmation a close operation asks for when it would end a running
 * agent (see App's requestClose). Closing a tab sends `POST
 * /sessions/:id/close`, which aborts the run, kills the session's
 * background commands and tears down its sub-agents — so the user chooses
 * between that and closing the tab alone, where the run keeps going on the
 * chat server and is reopened from the session history. Uses the shared
 * Modal, so Escape and a backdrop click cancel and the buttons are the
 * focus trap; Cancel comes first and therefore holds the initial focus. */
export function CloseTabsDialog({
  names,
  onCancel,
  onStopAndClose,
  onKeepRunning,
}: CloseTabsDialogProps) {
  const t = useT();
  const single = names.length === 1;
  // Every answer leaves the dialog. The two "close the tabs" answers also
  // hand the decision to the App, which is what removes this dialog — so the
  // decision is queued behind the exit (`close(after)`) instead of happening
  // while the sheet is still on screen (the dialog would vanish mid-click).
  return (
    <Modal onClose={onCancel}>
      {(close) => (
        <>
          <h2>{t("chrome.tabClose.title")}</h2>
          <p className="confirm-body">
            {single
              ? t("chrome.tabClose.body", { name: names[0]! })
              : t("chrome.tabClose.bodyMany", { count: names.length })}
          </p>
          {!single && (
            // One tab per row: the names are session titles (free text), so no
            // sentence tries to carry them inline.
            <ul className="confirm-list">
              {names.map((name, index) => <li key={index}>{name}</li>)}
            </ul>
          )}
          <p className="settings-note">
            {t("chrome.tabClose.keepRunningNote")}
          </p>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => close()}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => close(onKeepRunning)}
            >
              {t("chrome.tabClose.keepRunning")}
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => close(onStopAndClose)}
            >
              {t("chrome.tabClose.stop")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
