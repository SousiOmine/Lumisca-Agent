/**
 * The prompt behind the composer's `/skill` slash command: the palette lists
 * the session's skill catalog, and picking an entry turns the command line
 * into the user message built here — the agent is told to load exactly that
 * skill with the skill tool, so a skill can be invoked deliberately instead
 * of being left to the catalog's "matches this work" judgement.
 *
 * Browser-safe by contract (no disk / node builtins): the web bundle imports
 * this module through `@lumisca/core/skills/slash` (see coreSkillsSlashPath
 * in the server and the vite alias in packages/web). Keep it that way — a
 * runtime import of discover.ts would drag `node:path` into the client.
 */

/** Build the user message that invokes a skill: the agent loads the skill
 * with the skill tool and follows the instructions it finds there.
 * `request` is the text the user wrote around the `/skill <skill> ` command
 * line (e.g. `/skill canvas-design ポスターを作って`); empty means no
 * request — the skill's own instructions define the work. */
export function buildSkillPrompt(name: string, request: string): string {
  const subject = request.trim();
  const head =
    `スキル「${name}」を呼び出してください。skill ツールで「${name}」を読み込み、その指示に従って${
      subject.length === 0 ? "ください。" : "次の依頼を実行してください。"
    }`;
  return subject.length === 0 ? head : `${head}\n\n# 依頼内容\n${subject}`;
}
