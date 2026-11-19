import { useT } from "../../i18n.ts";
import { CompactionSettings } from "./CompactionSettings.tsx";
import { ModelList } from "./ModelList.tsx";
import { ModelPreferencePanel } from "./ModelPreferencePanel.tsx";
import { SettingsDisclosure } from "./SettingsDisclosure.tsx";

/**
 * Settings → モデル: the model to use, and everything that tunes it.
 *
 * The two rows a reader comes for come first — the model new conversations
 * start with, then the list of models a session may switch to. Everything
 * else (a model for sub-tasks, one for images, the compaction tuning) is a
 * fine point, so it sits behind one row at the foot of the page, named for
 * what it holds: shown all at once, the two that matter read as two among
 * nine.
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
      <ModelList />
      <SettingsDisclosure label={t("settings.model.more")}>
        <ModelPreferencePanel
          onOpenProviders={onOpenProviders}
          scope="others"
        />
        <CompactionSettings />
      </SettingsDisclosure>
    </>
  );
}
