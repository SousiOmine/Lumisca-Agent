import { useT } from "../i18n.ts";
import { Modal } from "./Modal.tsx";

interface ConfirmDialogProps {
  /** What the dialog asks, as its heading. */
  title: string;
  /** The consequence, in one or two sentences. */
  body: string;
  /** The label of the confirming button ("Delete", "Stop", …). */
  confirmLabel: string;
  /** Run the confirmed action. The dialog closes on its own; a handler that
   * throws leaves the dialog open so the failure is visible where the user
   * acted. */
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The one shape of a destructive confirmation inside the app.
 *
 * The browser's `confirm()` (confirm.ts) is still used where a blocking
 * answer is all that is needed, but it cannot say what is at stake with the
 * app's own typography, and it reads as an OS dialog rather than as part of
 * this window. Two dialogs had grown for the cases that needed more
 * (closing running tabs, deleting a stella agent); the agent one is this
 * component now.
 *
 * `CloseTabsDialog` stays separate on purpose: it offers three answers
 * (cancel / keep running / stop and close) and queues the two closing ones
 * behind the exit, so it is not this shape.
 *
 * The destructive button is last and `danger`-styled: the safe answer stays
 * where the pointer already is (the first button), and the dangerous one is
 * where the platform puts a forward action.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useT();
  return (
    <Modal onClose={onCancel} label={title}>
      <h2>{title}</h2>
      <p className="confirm-body">{body}</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
