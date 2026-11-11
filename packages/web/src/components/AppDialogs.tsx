import type { ComponentProps, ReactElement } from "preact/compat";
import { CloseTabsDialog } from "./CloseTabsDialog.tsx";
import { ModeGateDialog } from "./ModeGate.tsx";
import { RecentSessionsModal } from "./RecentSessionsModal.tsx";
import { SettingsModal } from "./SettingsModal.tsx";
import { AgentEditDialog } from "./stella/AgentEditDialog.tsx";

/**
 * The dialogs the app can have open, one optional set of props each.
 *
 * A closed dialog is `null` rather than a separate boolean: the caller already
 * decides whether to open it, and the dialog's own props are the only thing
 * this component needs. A missing one renders nothing.
 */
export interface AppDialogsProps {
  settings: ComponentProps<typeof SettingsModal> | null;
  recent: ComponentProps<typeof RecentSessionsModal> | null;
  close: ComponentProps<typeof CloseTabsDialog> | null;
  agentEdit: ComponentProps<typeof AgentEditDialog> | null;
  modeGate: ComponentProps<typeof ModeGateDialog> | null;
}

/** The modal layer of the app: settings, the session list, the close
 * confirmation, the agent editor and the mode chooser. */
export function AppDialogs({
  settings,
  recent,
  close,
  agentEdit,
  modeGate,
}: AppDialogsProps): ReactElement {
  return (
    <>
      {settings !== null && <SettingsModal {...settings} />}
      {recent !== null && <RecentSessionsModal {...recent} />}
      {close !== null && <CloseTabsDialog {...close} />}
      {agentEdit !== null && <AgentEditDialog {...agentEdit} />}
      {modeGate !== null && <ModeGateDialog {...modeGate} />}
    </>
  );
}
