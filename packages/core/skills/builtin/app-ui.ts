import { appHelp } from "../../shared/ui-app/help.ts";
import type { SkillDef } from "../discover.ts";

/**
 * The built-in "app-ui" skill: the JSON grammar of an app card.
 *
 * The grammar is large and most replies do not use it, so it is a skill
 * rather than part of the system prompt. `UI_HELP` in every prompt says
 * that a `ui` fence exists and names this skill; loading it is what teaches
 * the spec, the component catalog and the actions. The body is generated
 * from the same catalog the parser and the renderer use, so a component
 * added there appears here without a second list to forget.
 *
 * Available in every mode: an app card is part of a reply, and code mode,
 * chat and stella all have replies. Sub-agents do not receive it: their
 * text is a report to another model, not a screen.
 */
export function appUiSkill(): SkillDef {
  return {
    name: "app-ui",
    description:
      "Use this skill when a reply needs an interactive app card: a JSON " +
      "spec with state, actions, and a fixed component catalog. For " +
      "dashboards, forms, tabs, and multi-step controls. The card's state " +
      "is client-side and is not saved.",
    source: "builtin",
    read: (relativePath) => {
      if (relativePath !== undefined) {
        return Promise.reject(
          new Error(`No such file in skill "app-ui": ${relativePath}`),
        );
      }
      return Promise.resolve(appHelp());
    },
  };
}
