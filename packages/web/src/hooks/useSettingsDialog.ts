import type { ComponentProps } from "preact/compat";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type {
  SettingsCategory,
  SettingsModal,
} from "../components/SettingsModal.tsx";
import { isNotifyEnabled, setNotifyEnabled } from "../notify.ts";
import type { SettingsRoute } from "../route.ts";
import type { Locale, ThemeSetting } from "../types.ts";
import { useLanguage } from "./useLanguage.ts";
import { usePush } from "./usePush.ts";
import { useTheme } from "./useTheme.ts";
import { type UpdateControls, useUpdateStatus } from "./useUpdateStatus.ts";

/** The settings dialog's values, and the props they make. */
export interface AppSettings {
  theme: ThemeSetting;
  setTheme: (next: ThemeSetting) => void;
  language: Locale;
  /** Persist failure of the language setting (shown in the server
   * overview). */
  languageError: string | null;
  setLanguage: (next: Locale) => void;
  /** Auto-update state, shared with the settings panel and the update banner
   * so neither polls twice. */
  update: UpdateControls;
  /** The settings dialog's props, or null while it is closed. */
  settingsDialog: ComponentProps<typeof SettingsModal> | null;
  /** Bumped when the dialog closes (see below). */
  settingsVersion: number;
}

/**
 * Everything the settings dialog is drawn from: the two preferences it edits
 * for this device, the installation's update and push state, the server's
 * notification switch, and the address that says which page is showing.
 *
 * Collected here because the dialog is one screen with one set of values: it
 * covers whichever screen it was opened from, so the App and the setup
 * screen pass the same props object. `theme` and `language` come back out
 * because the first-run wizard edits the same two preferences before there
 * is a dialog to open.
 *
 * The two preferences are hooks of their own: the theme is this client's own
 * (localStorage), while the language is stored on the server because the
 * system prompt of a new session is generated there.
 */
export function useSettingsDialog(options: {
  /** The settings dialog's position in the address (null = closed). */
  settings: SettingsRoute | null;
  /** Move to another category (a navigation: the address names the page). */
  onOpenCategory: (category: SettingsCategory | null) => void;
  /** Back from a category page to the category list. */
  onBackToList: () => void;
  /** Close the dialog. */
  onClose: () => void;
}): AppSettings {
  const { settings, onOpenCategory, onBackToList, onClose } = options;
  const { theme, setTheme } = useTheme();
  // The language store was seeded from InitialData before the first render
  // (client.tsx); this hook owns the settings-dialog state and the persist
  // (a failed save rolls the UI back).
  const { language, setLanguage, error: languageError } = useLanguage();
  const update = useUpdateStatus(true);
  // Background agent-event notifications (desktop only): the event hook
  // reads the persisted value directly, so this state only drives the
  // settings toggle.
  const [notifyEnabled, setNotifyEnabledState] = useState(isNotifyEnabled);
  const onNotifyEnabledChange = useCallback((enabled: boolean) => {
    setNotifyEnabled(enabled);
    setNotifyEnabledState(enabled);
  }, []);
  // PWA notifications of this device (Web Push) are read only while the
  // dialog is open: the page has no other use for the state, and asking the
  // browser for it on every start would be a permission-adjacent read nobody
  // asked for.
  const push = usePush(settings !== null);

  // Bumped when the settings dialog closes: the draft re-reads the default
  // model there, since registering (or removing) a provider changes what a
  // new session would run on. A dialog without a provider change only costs
  // one cheap request.
  const open = settings !== null;
  const [settingsVersion, setSettingsVersion] = useState(0);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) {
      setSettingsVersion((version) => version + 1);
    }
    wasOpen.current = open;
  }, [open]);

  /** The settings dialog's props, or null while it is closed. */
  const settingsDialog: ComponentProps<typeof SettingsModal> | null =
    settings === null
      ? null
      : {
          theme,
          onThemeChange: setTheme,
          language,
          languageError,
          onLanguageChange: setLanguage,
          update,
          notifyEnabled,
          onNotifyEnabledChange,
          push,
          category: settings.category,
          onOpenCategory,
          onBackToList,
          onClose,
        };

  return {
    theme,
    setTheme,
    language,
    languageError,
    setLanguage,
    update,
    settingsDialog,
    settingsVersion,
  };
}
