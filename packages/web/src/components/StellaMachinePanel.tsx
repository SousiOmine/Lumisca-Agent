import { IconRefresh, IconRotate, IconSquare } from "@tabler/icons-preact";
import { useState } from "preact/compat";
import { api } from "../api.ts";
import { useT } from "../i18n.ts";
import type { AppModeStatus } from "../types.ts";
import { Modal } from "./Modal.tsx";

interface StellaMachinePanelProps {
  status: AppModeStatus;
  /** Re-read the status after an operation. */
  onStatus: (status: AppModeStatus) => void;
}

/**
 * The virtual machine's controls, in the stella view's header: start / stop /
 * reset, and the state the server reports.
 *
 * Starting is the slow one (building the image takes minutes on a first run),
 * so the button says what it is doing while it waits — a spinner over an
 * unchanged label reads as a hang.
 *
 * "Reset" is destructive in a way the others are not: everything inside the
 * machine goes with it. It asks first, and says what survives (the
 * conversation) so the choice is informed.
 */
export function StellaMachinePanel(
  { status, onStatus }: StellaMachinePanelProps,
) {
  const t = useT();
  const [busy, setBusy] = useState<"start" | "stop" | "reset" | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = status.state === "running";
  const canStart = status.availability.available && !running;

  // The state label: the machine's own vocabulary, translated.
  const stateLabel = (() => {
    switch (status.state) {
      case "podman_missing":
        return t("chat.stella.machine.state.podman_missing");
      case "image_missing":
        return t("chat.stella.machine.state.image_missing");
      case "container_missing":
        return t("chat.stella.machine.state.container_missing");
      case "stopped":
        return t("chat.stella.machine.state.stopped");
      case "running":
        return t("chat.stella.machine.state.running");
      default:
        return t("chat.stella.machine.state.unavailable");
    }
  })();

  const run = async (
    kind: "start" | "stop" | "reset",
    work: () => Promise<AppModeStatus>,
  ) => {
    setBusy(kind);
    setError(null);
    try {
      onStatus(await work());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      // Re-read anyway: a failed start may still have changed the state
      // (an image built but the container failing, for one).
      try {
        onStatus(await api.getStellaStatus());
      } catch {
        // Keep the error above; the state simply stays as it was.
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stella-machine">
      <span className={`stella-machine-state ${running ? "on" : "off"}`}>
        {busy === "start" ? t("chat.stella.machine.starting") : stateLabel}
      </span>
      {canStart && (
        <button
          type="button"
          className="btn small"
          disabled={busy !== null}
          onClick={() => void run("start", api.startStella)}
        >
          <IconRotate size={14} />
          {t("chat.stella.machine.start")}
        </button>
      )}
      {running && (
        <button
          type="button"
          className="btn small"
          disabled={busy !== null}
          onClick={() => void run("stop", api.stopStella)}
        >
          <IconSquare size={13} />
          {t("chat.stella.machine.stop")}
        </button>
      )}
      {busy === "start" && (
        <span className="stella-machine-note">
          {t("chat.stella.machine.building")}
        </span>
      )}
      {!running && status.availability.available && (
        <button
          type="button"
          className="icon-btn"
          title={t("chat.stella.machine.reset")}
          aria-label={t("chat.stella.machine.reset")}
          disabled={busy !== null}
          onClick={() => setConfirmReset(true)}
        >
          <IconRefresh size={15} />
        </button>
      )}
      {error && (
        <span className="error-text stella-machine-error" role="alert">
          {error}
        </span>
      )}
      {confirmReset && (
        <Modal onClose={() => setConfirmReset(false)}>
          <h2>{t("chat.stella.machine.resetTitle")}</h2>
          <p className="confirm-body">
            {t("chat.stella.machine.resetBody")}
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="btn"
              onClick={() => setConfirmReset(false)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                setConfirmReset(false);
                void run("reset", api.resetStella);
              }}
            >
              {t("chat.stella.machine.reset")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
