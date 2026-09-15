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
 * line (e.g. `/skill canvas-design make a poster`); empty means no request —
 * the skill's own instructions define the work.
 *
 * English, like every prompt the app sends: the language of the answer is
 * fixed by the session's system prompt (tools/language.ts). */
export function buildSkillPrompt(name: string, request: string): string {
  const subject = request.trim();
  const head = `Invoke the skill "${name}": load it with the skill tool and ` +
    (subject.length === 0
      ? "follow the instructions it provides."
      : "then carry out the request below.");
  return subject.length === 0 ? head : `${head}\n\n# Request\n${subject}`;
}
