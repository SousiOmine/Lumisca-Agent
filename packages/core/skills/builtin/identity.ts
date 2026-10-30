import type { SkillDef } from "../discover.ts";

/**
 * The built-in "identity" skill: what the `identity` tool is for and when to
 * write with it.
 *
 * The tool is discoverable rather than preloaded (see tools/registries.ts and
 * agent/factory.ts) because it belongs to this conversation's own agent — a
 * sub-agent must not rewrite the identity of the agent that started it. Its
 * contract (two actions, a character cap, "a write reaches the next run") is
 * in the tool's own description; what this skill adds is the judgement the
 * description cannot carry: what belongs in an identity, and what must never
 * be written into one.
 *
 * A code-mode session must not advertise it (BuiltinContext.stella).
 */

/** The SKILL.md body. English, like the tool descriptions it quotes. */
const SKILL_MD = `# Your identity

Your identity is the text you write about yourself: the role you have taken,
what you are responsible for, and the knowledge your work needs. You own it,
and it is separate from the role the user gave you when they created you —
that one stays as they wrote it.

## What belongs in it

- The role you actually play for this person, in a sentence or two.
- What you are responsible for, and what you leave to them.
- What you have learned that a future you would need: their preferences,
  the shape of their project, the conventions of their work, the traps you
  have already hit.
- How you work: when you check before acting, when you ask, what you
  consider done.

Keep it under 4,000 characters. Short and specific beats long and vague: it
is read at the start of every future turn, so a paragraph of platitudes
costs attention and says nothing.

## What does not belong in it

- Secrets: passwords, tokens, API keys, private URLs. It is stored in plain
  text and travels with the conversation.
- A copy of the conversation, or a log of what you did. The history is
  already kept; the identity is the standing facts, not the diary.
- Instructions you were given for one task. Those were for that task.

## How to use it

1. tool_search with the query "identity" to get the arguments.
2. tool_call with name "identity" and { action: "read" } to see what is
   stored. It returns nothing the first time.
3. Write with { action: "write", content: "..." } when you have learned
   something worth keeping across sessions — not on your first turn, before
   you know anything.
4. Update it when what you know changes. An empty content clears it.

A write does not change what you see in the current run: it reaches your
context when the next run starts. Use { action: "read" } to confirm what is
stored instead of assuming the text above changed.
`;

/** Build the built-in identity skill definition. Content is embedded (no
 * filesystem), so it survives bundling and any working directory. */
export function identitySkill(): SkillDef {
  return {
    name: "identity",
    description:
      "Your own identity: the text you write about yourself (your role, what " +
      "you are responsible for, the knowledge the work needs), separate from " +
      "the role the user wrote. The identity tool is not preloaded — find it " +
      "with tool_search.",
    source: "builtin",
    read: (relativePath) => {
      if (relativePath !== undefined) {
        // One file per built-in skill: no follow-up files exist. The message
        // mirrors the file-based skills' read error.
        return Promise.reject(
          new Error(`No such file in skill "identity": ${relativePath}`),
        );
      }
      return Promise.resolve(SKILL_MD);
    },
  };
}
