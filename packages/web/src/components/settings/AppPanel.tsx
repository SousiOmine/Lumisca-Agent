import type {
  UpdateFailureKind,
  UpdateSource,
} from "../../hooks/useUpdateStatus.ts";
import { useT } from "../../i18n.ts";
import type { UpdateStatus } from "../../shell.ts";
import { UpdateSection } from "./UpdateSection.tsx";

interface AppPanelProps {
  status: UpdateStatus | null;
  source: UpdateSource | null;
  bridgeError: string | null;
  failure: UpdateFailureKind | null;
  onSetAuto: (enabled: boolean) => void;
  onSetAutoRestart: (enabled: boolean) => void;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onRestart: () => void;
}

/**
 * Settings → アプリ: the desktop program the reader launched.
 *
 * This page exists only inside the desktop shell, and only the shell can
 * answer for it. When the bridge is down, the server's updater answers
 * instead; that updater owns a different program, so the page says the app's
 * updater could not be read instead of drawing controls that would update
 * the server under the app's name.
 */
export function AppPanel({
  status,
  source,
  bridgeError,
  failure,
  onSetAuto,
  onSetAutoRestart,
  onCheck,
  onDownload,
  onInstall,
  onRestart,
}: AppPanelProps) {
  const t = useT();
  if (source === "shell" || source === null) {
    return (
      <div className="settings-pane">
        <UpdateSection
          status={status}
          source={source}
          bridgeError={bridgeError}
          failure={failure}
          onSetAuto={onSetAuto}
          onSetAutoRestart={onSetAutoRestart}
          onCheck={onCheck}
          onDownload={onDownload}
          onInstall={onInstall}
          onRestart={onRestart}
        />
      </div>
    );
  }
  return (
    <div className="settings-pane">
      <p className="settings-note">{t("settings.app.noShell")}</p>
      {bridgeError !== null && <p className="error-text">{bridgeError}</p>}
    </div>
  );
}
