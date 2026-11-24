import type {
  UpdateFailureKind,
  UpdateSource,
} from "../../hooks/useUpdateStatus.ts";
import { useT } from "../../i18n.ts";
import { inDesktopShell, type UpdateStatus } from "../../shell.ts";
import type { ThemeSetting } from "../../types.ts";
import { AppearancePanel } from "./AppearancePanel.tsx";
import { UpdateSection } from "./UpdateSection.tsx";

interface AppPanelProps {
  /** The theme this client draws with (see AppearancePanel). */
  theme: ThemeSetting;
  onThemeChange: (theme: ThemeSetting) => void;
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
 * Settings → アプリ: the program the reader is looking through — its theme,
 * and the desktop shell's updater when the shell is what serves the page.
 *
 * The theme is the window's own value, so it sits on this page for the same
 * reason the updater does: both answer for the client in front of the reader.
 * It used to have a page of its own (外観) holding one row; a category per
 * preference made the navigation longer without making the preference easier
 * to find.
 *
 * Only the desktop shell can answer for its updater. When the bridge is down,
 * the server's updater answers instead; that updater owns a different
 * program, so the page says the app's updater could not be read instead of
 * drawing controls that would update the server under the app's name. A
 * plain browser has no app to update at all: it gets the theme and nothing
 * else, rather than an updater panel explaining a program that is not there.
 */
export function AppPanel({
  theme,
  onThemeChange,
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
  const update = !inDesktopShell() ? null : source === "shell" ||
    source === null ? (
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
  ) : (
    <>
      <p className="settings-note">{t("settings.app.noShell")}</p>
      {bridgeError !== null && <p className="error-text">{bridgeError}</p>}
    </>
  );
  return (
    <>
      <AppearancePanel theme={theme} onThemeChange={onThemeChange} />
      {update !== null && <div className="settings-pane">{update}</div>}
    </>
  );
}
