import type { AppMode } from "@lumisca/core/shared";
import { useState } from "preact/compat";
import { useT } from "../i18n.ts";
import { Modal } from "./Modal.tsx";
import type { ModeSelectViewProps } from "./ModeSelectView.tsx";
import { ModeSelectView } from "./ModeSelectView.tsx";

/**
 * The mode chooser, in the one place it is shown: the "switch mode" dialog
 * from the app menu.
 *
 * It used to be the app's first screen too, for a client that had never
 * chosen. A bare `/` now starts in the main mode (Lumisca, see
 * hooks/useAppMode.ts), so choosing is a deliberate act from the menu rather
 * than a gate in front of the app; the dialog is what remains.
 *
 * The host owns the busy state, so the cards cannot be double-clicked into
 * two different modes while the server verdict is in flight, and the dialog
 * keeps itself open on a refusal (closing it would hide why nothing
 * happened).
 */
export interface ModeGateProps
  extends Omit<ModeSelectViewProps, "busy" | "onChoose"> {
  /** Choose the mode. Resolves when the choice is stored (or refused). */
  choose: (mode: AppMode) => Promise<void>;
}

/** The "switch mode" dialog. A refusal keeps it open showing its reason. */
export function ModeGateDialog(view: ModeGateProps & { onClose: () => void }) {
  const t = useT();
  const { onClose, ...rest } = view;
  return (
    <ModeSelectHost {...rest} onChosen={onClose}>
      {(shared) => (
        <Modal onClose={onClose} label={t("chat.modeSelect.title")}>
          <ModeSelectView {...shared} />
        </Modal>
      )}
    </ModeSelectHost>
  );
}

/**
 * The busy state and the choose handler, kept out of the view.
 *
 * `onChosen` runs only on success: a refusal (stella on a server without a
 * usable machine) leaves the chooser where it is, showing the reason.
 */
function ModeSelectHost({
  status,
  mode,
  error,
  choose,
  onChosen,
  children,
}: Omit<ModeGateProps, "busy"> & {
  onChosen?: () => void;
  children: (
    view: Omit<ModeSelectViewProps, "busy" | "onChoose"> & {
      busy: boolean;
      onChoose: ModeSelectViewProps["onChoose"];
    },
  ) => preact.JSX.Element;
}) {
  const [busy, setBusy] = useState(false);
  const onChoose = (next: AppMode) => {
    setBusy(true);
    void choose(next).then(
      () => {
        setBusy(false);
        onChosen?.();
      },
      () => setBusy(false),
    );
  };
  return children({ status, mode, error, busy, onChoose });
}
