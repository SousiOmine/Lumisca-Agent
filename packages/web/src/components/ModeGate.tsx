import type { AppMode } from "@lumisca/core/shared";
import { useState } from "preact/compat";
import { useT } from "../i18n.ts";
import { Modal } from "./Modal.tsx";
import type { ModeSelectViewProps } from "./ModeSelectView.tsx";
import { ModeSelectView } from "./ModeSelectView.tsx";

/**
 * One place that shows the mode chooser, in the two shapes it is needed.
 *
 * The same view appears as the app's first screen (no mode stored yet) and
 * inside the "switch mode" dialog from the app menu. App.tsx rendered it at
 * both sites with the same five props, and the busy/refusal rules lived beside
 * those render calls: a change to how a refusal is shown had to be made twice,
 * and one of the two could drift (the dialog keeps itself open on a refusal,
 * because closing it would hide why nothing happened).
 *
 * `Gate` is the screen, `Dialog` is the modal. Both own the busy state, so the
 * cards cannot be double-clicked into two different modes while the server
 * verdict is in flight.
 */
export interface ModeGateProps
  extends Omit<ModeSelectViewProps, "busy" | "onChoose"> {
  /** Choose the mode. Resolves when the choice is stored (or refused). */
  choose: (mode: AppMode) => Promise<void>;
}

/** The first screen: the chooser, full page. */
export function ModeGate(view: ModeGateProps) {
  return (
    <ModeSelectHost {...view}>
      {(shared) => <ModeSelectView {...shared} />}
    </ModeSelectHost>
  );
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
 * The busy state and the choose handler, shared by both shapes.
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
