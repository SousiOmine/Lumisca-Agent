/**
 * stella mode's model, in the settings dialog.
 *
 * A stella conversation is one ongoing chat with one agent: the model is a
 * property of that conversation, not a per-message choice. Code mode's model
 * line sits in the composer because switching there is routine — a question
 * wants a fast model, a refactor wants a strong one. A conversation the user
 * returns to for weeks does not work that way, and a control in the composer
 * spends a row of every screen on a choice that is made once.
 *
 * So the composer keeps no model line (see StellaView), and this panel is
 * where the choice lives. It is also the way out of a conversation pinned to
 * a model that was retired or whose provider went away: without it, deleting
 * the agent (and the conversation with it) would be the only escape.
 *
 * The thinking rail stays beside the model, the same as code mode's: a level
 * belongs to the model, and a long request is where it matters most.
 */
import { ModelPicker } from "../ModelPicker.tsx";
import { useT } from "../../i18n.ts";
import type { ThinkingLevel } from "../../types.ts";
import type { StellaConversationState } from "../../stella-state.ts";

export interface StellaModelPanelProps {
  /** The open conversation, or null before one is opened. Its model is the
   * session row's choice, so it is the same value the composer used to
   * show. */
  conversation: StellaConversationState | null;
  /** Switch the conversation's model (refused while a run is active). */
  onModelChange: (provider: string, modelId: string) => Promise<void>;
  /** Set the thinking strength of the conversation's model. */
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  /** Open the provider settings (a missing provider is the usual reason no
   * model can be picked). */
  onOpenProviders: () => void;
}

export function StellaModelPanel(props: StellaModelPanelProps) {
  const t = useT();
  const model = props.conversation?.model ?? null;
  const thinking = props.conversation?.thinking ?? null;
  return (
    <section className="settings-section">
      <h3 className="settings-section-title">
        {t("settings.stellaModel.title")}
      </h3>
      <p className="settings-section-note">
        {t("settings.stellaModel.note")}
      </p>
      {model === null
        ? <p className="settings-note">{t("settings.stellaModel.noAgent")}</p>
        : (
          <ModelPicker
            value={model}
            stacked
            onClose={() => {}}
            onSelect={(provider, modelId) => {
              void props.onModelChange(provider, modelId);
            }}
            onOpenSettings={props.onOpenProviders}
            thinkingValue={thinking?.level}
            thinkingLevels={thinking?.levels}
            onThinkingChange={props.onThinkingLevelChange}
          />
        )}
    </section>
  );
}
