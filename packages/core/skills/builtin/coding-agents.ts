import type { SkillDef } from "../discover.ts";

/**
 * The built-in "coding-agents" skill: how to hand a coding job to
 * sub-agents (the `task` tool).
 *
 * This is the only thing that tells an agent the work is big enough to
 * split — the system prompt deliberately describes the machine, not a
 * procedure, and a tool description can only state the contract of one
 * call. The description is therefore the trigger (the catalog shows only
 * `name: description`) and the body is the how.
 *
 * The `task` family is preloaded exactly where this skill is advertised
 * (the catalog's `subagents` flag is the same fact as the tool hub), so the
 * body calls `task` directly. Teaching tool_search here made an agent that
 * followed the guide literally conclude it could not delegate — the search
 * only covers the session registry, and a preloaded tool is not in it.
 */

/** The SKILL.md body. English, like the tool descriptions it quotes. */
const SKILL_MD = `# Handing coding work to sub-agents

A sub-agent is another coding agent that starts with none of this
conversation. It works on one job and reports back. Its transcript is not
saved, so the report is the only trace of what it did — and the prompt is
the only thing it knows.

## Split the job

Decide the parts before starting anything. A part is worth delegating
when it:

- does not need another part's output;
- touches files no other part touches (two agents writing one file
  conflict, and the mess is yours to untangle);
- can be described in two sentences. A part that needs paragraphs comes
  back wrong.

## Start every part in one turn

\`task\` is in your tool set. Call it once per part, all in the same turn:
waiting for the first to finish before starting the second is the serial
version of the same work. Up to 8 may run at once.

    task(subagent_type: "general",
         description: "Short name shown in the list",
         prompt: "The self-contained job description")

## What the prompt must carry

The sub-agent cannot ask you anything, so the prompt has to stand alone.
Say what done looks like, not how to do it — it decides that.

    Goal: what done looks like
    Files: the paths it needs, and the ones it must not touch
    Constraints: what must not change, which tests must pass
    Report: files touched, what was verified, what is left

Do not paste this conversation into the prompt and do not write "see
above": there is no above. A sub-agent handed the conversation instead of
the job comes back with a summary of the conversation.

## Which type

- \`general\` reads, writes, runs commands, and may start its own
  sub-agents. Use it to implement.
- \`explore\` is read-only. Use it to find out how something works, and
  for reviews where nothing may change.

## While they run

Keep working: read files, plan, write the part that is yours. Do not
duplicate a part you started, and do not edit a file you gave to an agent
that is still running.

## Collect

- \`task_output\` with \`wait: true\` when you have nothing else to do;
  otherwise keep working and read the \`[Task <id> ...]\` notification.
- Treat the report as work to review, not as a result to trust: open the
  diff before accepting it.

## Gotchas

- A task still running when this conversation closes is aborted and its
  report is lost. Start long work early and collect it before you finish.
- Reports arrive as notifications even while you are idle; do not poll in
  a tight loop.
- A fact only this conversation knows will never reach the sub-agent
  unless you put it in the prompt.
`;

/** Build the built-in coding-agents skill definition. Content is embedded
 * (no filesystem), so it survives bundling and any working directory. */
export function codingAgentsSkill(): SkillDef {
  return {
    name: "coding-agents",
    description:
      "Use this skill whenever the user asks for a coding job bigger than a " +
      "few edits — implementing a feature, fixing a bug across several " +
      "files, porting or refactoring code, or working on several " +
      "independent problems at once — or when you judge the work to be a " +
      "program rather than an edit. It covers splitting the job across " +
      "sub-agents that run at the same time (up to 8), what each " +
      "sub-agent's prompt must carry, which type to use, and how to " +
      "collect and check the reports. Use it even if the user does not say " +
      "'sub-agent' or 'delegate'. Skip it for a quick fix of a few tool " +
      "calls, a question, or a change that depends on this conversation's " +
      "history.",
    source: "builtin",
    read: (relativePath) => {
      if (relativePath !== undefined) {
        // One file per built-in skill: no follow-up files exist. The message
        // mirrors the file-based skills' read error.
        return Promise.reject(
          new Error(`No such file in skill "coding-agents": ${relativePath}`),
        );
      }
      return Promise.resolve(SKILL_MD);
    },
  };
}
