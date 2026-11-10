import type { SkillDef } from "../discover.ts";

/**
 * The built-in "routines" skill: a request this conversation runs on a
 * schedule by itself.
 *
 * The five tools (routine_create / routine_list / routine_update /
 * routine_delete / routine_run, see routine/tools.ts) are discoverable rather
 * than preloaded: a routine is set up once and runs on its own, so five
 * definitions would be paid for on every turn of every conversation. Without
 * a guide, an agent that is asked "check the deploy every morning" simply
 * checks it now and forgets — the tools exist but nothing asks for them, and
 * the settings screen's promise ("ask the agent for one") was not kept. That
 * is what this skill fixes: it teaches when a routine is the answer, and what
 * the tool descriptions cannot carry about a run nobody is watching.
 *
 * Advertised only in a stella conversation (BuiltinContext.stella): routines
 * belong to an agent, and a code-mode session has none.
 */

/** The SKILL.md body. English, like the tool descriptions it quotes. */
const SKILL_MD = `# Routines

A routine is a request this conversation runs by itself: at a time, or when
something changes. Its result appears here, next to everything else you
said, marked with the routine's name.

The tools are not preloaded. Find them with tool_search (query "routine")
and call them with tool_call.

## When a routine is the answer

- "Every morning at 8, check the deploy."
- "Tell me when the deploy page changes."
- "Run this every 30 minutes."
- "Tomorrow at 9, send me the release notes."

Not the answer when the user wants it once, now (do the work), or wants to be
reminded of a fixed text (that is a calendar, not this). Offer a routine,
describe what it will do, and create it in the same turn when the request is
clear. If the time or the condition is ambiguous, ask before creating.

A single future request is a \`once\` routine. A one-off time that has already
passed is not a routine at all: do the work now, and say that is what you
did.

## The schedule shapes

Times are the machine's local time. \`weekly\` days are 1 = Monday … 7 =
Sunday. Intervals are whole minutes from 5 to 1440.

- \`{"kind":"daily","time":"08:30"}\`
- \`{"kind":"weekly","days":[1,5],"time":"18:00"}\`
- \`{"kind":"every","minutes":30}\`
- \`{"kind":"once","at":"2026-11-12 09:00"}\`
- \`{"kind":"watch","everyMinutes":10,"source":{...}}\`

\`once\` names a date as well as a time (\`YYYY-MM-DD HH:MM\`, the machine's
own clock): "tomorrow at 9" is \`at\` with tomorrow's date written out, not a
\`daily\`. It runs a single time and then removes itself from the list; the
result stays in this conversation. Running it earlier with \`routine_run\`, or
with "Run now" in the settings list, uses it up the same way — say so if the
user asks before its time. A time that has already passed is refused; a time
that came while the machine was off runs when it starts again.

A \`watch\` is checked by the server without asking you: it reads one thing
and starts a run only when that thing changed. It costs nothing when nothing
changed, so it can be frequent. Four sources:

- \`{"kind":"http","url":"https://...","expect":{"status":200}}\` — or
  \`{"expect":{"includes":"..."}}\`, or \`{"expect":{"hash":true}}\`.
- \`{"kind":"file","path":"app.log","compare":"mtime"}\` — or \`"hash"\`.
- \`{"kind":"command","command":"git diff --quiet","expect":{"exitCode":0}}\`
  — or \`{"expect":{"includes":"..."}}\`.
- \`{"kind":"mcp","server":"composio","tool":"GMAIL_FETCH_EMAILS","args":{"query":"is:unread"},"expect":{"ids":"data.messages[].id"}}\`.

Relative paths and commands are relative to your own working folder, and the
check runs inside your machine: a local development address works, the host's
network does not come into it.

An \`mcp\` watch is the one check that does not run in your machine: it calls
the tool through the server's own connection, the one you call, so it keeps
working while the machine is down. Its answer must be JSON, and the path
names the field to compare — a segment ending in \`[]\` maps over the array it
names (\`data.messages[].id\` is every message's id). \`{"ids":...}\` fires when
an id appears that the last check did not see: an item being read, edited or
deleted is not a change. Use \`{"hash":...}\` instead when there is no list of
items and one value changing is the event.

Only a tool that reads can be watched. The server's \`readOnlyHint\` decides
when it sends one, and otherwise the name must have GET, LIST, FETCH, SEARCH,
READ, FIND, QUERY, LOOKUP or VIEW. A send/create/delete tool is refused when
you save the routine, because a check has nobody watching: a write tool there
would act every few minutes on its own. The server must be one from Settings
→ MCP servers; a workspace's or a plugin's server is not in scope.

This is a poll, not a notification: the delay is the interval, so "tell me
the moment it arrives" is not what a watch gives. The run is told how many
items appeared, and calling the tool with the same arguments shows them.

Two consequences to tell the user about:

- The first check only records what it saw. Saving a watch does not run it
  once to find out; the first run happens when the watched thing changes.
- A check that cannot run (the machine is stopped, an address that does not
  answer) is recorded as a failed check, not as a run, and is retried later.
  Nothing is reported as run that was not.

## Silence

A run has nobody watching. If the routine found nothing worth acting on, end
with exactly \`NO_RESPONSE\` and nothing else: the run then leaves no trace in
the conversation. A routine whose request always answers "all good" would
otherwise fill the history with rows nobody reads. Say what the prompt
decides is worth reporting.

## How to use the tools

1. tool_search with the query "routine".
2. tool_call "routine_list" to see this conversation's routines: schedule,
   next run, last run, and the last check.
3. tool_call "routine_create" with \`{ name, prompt, schedule }\`. The prompt
   is what you will read on the day it runs, with nobody there to explain it:
   write the whole instruction, not a reminder of one ("check the deploy and
   summarize what changed; say nothing if it is green").
4. tool_call "routine_update" to change the name, request, schedule or
   enabled state. Only the fields you pass change. A new schedule starts a
   fresh baseline for a watch, so changing what is watched does not fire a
   run for the difference.
5. tool_call "routine_run" to run it once now, without moving the schedule.
   A \`once\` routine is used up by that run, so it is not a way to try one
   out.
6. tool_call "routine_delete" to remove it; its past runs stay in the
   conversation. Confirm with the user first — this cannot be undone.

Names are unique within this conversation, and it holds at most 50 routines.

## What a run is

A run is an ordinary turn with the routine's prompt as the user's message, so
you have every tool you normally have. If the conversation is busy when the
routine is due, the run waits for it: up to an hour, then it is skipped and
the list says why. The result reaches the same place as any reply — do not
send it to another channel or promise that it will.

Do not promise when it will be read: the app notifies the user when the run
finishes if they are not looking at it, and otherwise the answer is simply
there.`;

/** Build the built-in routines skill definition. Content is embedded (no
 * filesystem), so it survives bundling and any working directory. */
export function routinesSkill(): SkillDef {
  return {
    name: "routines",
    description:
      "Requests this conversation runs on a schedule by itself: daily, " +
      "weekly, every N minutes, once at a given date and time, or when " +
      "something changes (a URL, a file, a command). The routine tools are " +
      "not preloaded — find them with tool_search.",
    source: "builtin",
    read: (relativePath) => {
      if (relativePath !== undefined) {
        // One file per built-in skill: no follow-up files exist. The message
        // mirrors the file-based skills' read error.
        return Promise.reject(
          new Error(`No such file in skill "routines": ${relativePath}`),
        );
      }
      return Promise.resolve(SKILL_MD);
    },
  };
}
