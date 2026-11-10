import type { SkillDef } from "../discover.ts";

/**
 * The built-in "vm-env" skill: how the agent gets a secret it must not know.
 *
 * The `vm_env` tool is discoverable rather than preloaded — a conversation
 * that never needs an API key pays nothing for its definition — and nothing
 * else would tell the agent it exists. That is this skill's job, and the
 * rest of it is what a tool description cannot carry: that the value is
 * entered by the user in a dialog, that the run waits, that the value never
 * comes back, and what to do when the user declines.
 *
 * Advertised only in a stella conversation (BuiltinContext.stella): the
 * variables belong to the machine, and code mode has no machine.
 */

/** The SKILL.md body. English, like the tool descriptions it quotes. */
const SKILL_MD = `# Environment variables

Some work needs a secret you do not have: an API key for a service, a token
for a repository, a password for a database. Do not ask the user to paste it
into the chat — that puts it into the conversation forever — and do not
invent one. Ask for it as a NAMED variable instead: the user types the value
into a dialog, it goes straight into your machine, and you never see it.

The tool is not preloaded. Find it with tool_search (query "environment
variable" or "secret") and call it with tool_call.

## When to use it

- A command failed because a key was missing, and the user has one.
- A tool (gh, gh auth, npm, an SDK) needs a token that is not configured.
- The user asks you to set up a service that needs their credentials.

Not for a value you can generate or find yourself (a random port, a path),
and not for something the user should type into the program itself while you
watch the screen — that is vm_ask_user's job when a GUI asks for it.

## What happens

1. tool_call "vm_env" with { name: "OPENAI_API_KEY" }. Use the name the
   program reads, in its own spelling (the one its documentation or error
   message names). If the user calls it something else, ask them which
   variable the program expects rather than inventing one.
2. A dialog appears in the conversation for the user, and the run stops
   until they answer. That is normal: the run is waiting for a person.
3. If they enter it, every command you run from then on — bash and
   async_bash — has it as \$NAME. The tool's result says so, and nothing
   more: the value itself is never returned to you.
4. If they decline, the result says so. Work without the variable and say
   what cannot be done; do not open the dialog again in a loop.
5. If nobody answers within 15 minutes the dialog closes and the tool says
   the value is not available. Continue, or stop and say what you need;
   calling the tool again starts a new wait.

## Using it

Pass the variable to the program and let the program read it:

    gh auth login --with-token < /dev/null   # (only if it reads it from env)
    curl -H "Authorization: Bearer \$OPENAI_API_KEY" https://api.example.com

Do not print the value, and do not write it into a file, a card or the
conversation: you do not know it, and a command that echoes it puts it into
the transcript for good. If you need to know whether it is set, test for its
presence instead — \`[ -n "\$OPENAI_API_KEY" ]\` — rather than reading it.

Two limits worth knowing:

- Only the shell gets the variable. A GUI program started with vm_launch does
  not inherit it; if an app needs the key, start it from bash with the
  variable in the command's environment.
- The variables belong to the MACHINE, not to this conversation: another
  agent's conversation on the same machine sees the same variables.

## Replacing one

Asking for a name that already has a value is allowed and replaces it — the
dialog says so. That is how a rotated key is entered. Do not replace a value
the user did not mention changing.
`;

/** Build the built-in vm-env skill definition. Content is embedded (no
 * filesystem), so it survives bundling and any working directory. */
export function vmEnvSkill(): SkillDef {
  return {
    name: "vm-env",
    description:
      "Ask the user for an environment variable's value (an API key, a " +
      "token, a password) so a program can use it without you ever seeing " +
      "it. The vm_env tool is not preloaded — find it with tool_search.",
    source: "builtin",
    read: (relativePath) => {
      if (relativePath !== undefined) {
        // One file per built-in skill: no follow-up files exist. The message
        // mirrors the file-based skills' read error.
        return Promise.reject(
          new Error(`No such file in skill "vm-env": ${relativePath}`),
        );
      }
      return Promise.resolve(SKILL_MD);
    },
  };
}
