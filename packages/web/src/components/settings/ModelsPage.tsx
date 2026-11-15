import { useT } from "../../i18n.ts";
import { CompactionSettings } from "./CompactionSettings.tsx";
import { ModelList } from "./ModelList.tsx";
import { ModelPreferencePanel } from "./ModelPreferencePanel.tsx";
import { SettingsDisclosure } from "./SettingsDisclosure.tsx";

/**
 * Settings → モデル: the model to use, and everything that tunes it.
 *
 * Two things here are what a reader comes for — the model new conversations
 * start with, and the list of models a session may switch to. The rest (a
 * model for sub-tasks, one for images, the compaction tuning) is a fine
 * point, so it sits behind one "詳細" for the page: shown all at once, the
 * two that matter read as two among nine.
 */
export function ModelsPage({
  onOpenProviders,
}: {
  onOpenProviders: () => void;
}) {
  const t = useT();
  return (
    <>
      <ModelPreferencePanel onOpenProviders={onOpenProviders} />
      <SettingsDisclosure label={t("settings.model.details")}>
        <ModelPreferencePanel
          onOpenProviders={onOpenProviders}
          scope="others"
        />
        <CompactionSettings />
      </SettingsDisclosure>
      <ModelList />
    </>
  );
}
