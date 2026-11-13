import type { SkillDef } from "../discover.ts";

/**
 * The built-in "folder-share" skill: how the agent gets at a folder on the
 * user's computer, and how it gives one back.
 *
 * Both tools are discoverable rather than preloaded — a conversation that
 * never touches the user's disk pays nothing for their definitions — and
 * nothing else would tell the agent they exist. That is this skill's job. The
 * rest is what a tool description cannot carry: that the folder is on ANOTHER
 * computer, that the loan is temporary, that the user chooses the terms, and
 * that the announcement of what is lent arrives as a message rather than as a
 * tool result.
 *
 * Advertised only in a stella conversation (BuiltinContext.stella): a lent
 * folder hangs under `/lend`, which is a stella session's namespace. Code
 * mode works in workspace folders the user configured, and has no such
 * surface.
 */

/** The SKILL.md body. English, like the tool descriptions it quotes. */
const SKILL_MD = `# Folders lent from the user's computer

The machine you work in is not the user's computer. Their files are elsewhere:
a project on their desktop, exports in Downloads, a folder they are working in
right now. You can be given one of those folders for a while — the user lends
it — and then it appears in your namespace as /lend/<name>.

Two tools manage that, and neither is preloaded. Find them with tool_search
(query "lend folder" or "share folder") and call them with tool_call.

## Asking for a folder (share_request)

Use it when the work needs files that are on THEIR disk and not in your
machine: "read the CSV exports in my Downloads folder", "look at the project
in ~/src/site".

1. tool_call "share_request" with { reason: "…" }. The reason is one sentence
   and the user reads it in a card, so say what you need the folder for, not
   that you need "a folder".
2. A card appears in the conversation and the run stops until the user
   answers. That is normal: the run is waiting for a person.
3. They press "choose a folder" and pick one in the OS dialog, set the terms
   (read only, or read and write), and share it. The tool then returns the
   path it is reachable at — /lend/<name> — and the run continues.
4. If they decline, the result says so. Say what cannot be done without it
   and carry on; do not open the card again in a loop.
5. If nobody answers within 15 minutes the card closes and the tool says no
   folder was lent. Calling it again starts a new wait.

The loan is the user's decision and it is temporary: it ends 30 minutes after
the last use, and they can withdraw it at any moment from the conversation's
information panel. A message in your context lists what is lent right now;
read that rather than assuming a folder is still there.

## Using a lent folder

- Address it by ABSOLUTE path: /lend/<name>, and anything below it. A
  relative path never reaches it — relative paths resolve against your
  working folder inside the machine.
- A command whose working directory is inside a lent folder runs on the
  user's computer, in their shell (the announcement says which one: zsh,
  PowerShell, bash). So \`cd\` there and run \`git status\` or \`grep\` as you
  would anywhere; but do not assume the tools, paths or OS of your own
  machine. \`/Users/...\` and \`C:\\...\` exist there, not here.
- read and write work on text. To move a file across unchanged — a picture, a
  PDF, an archive — use share_upload and share_download (also found with
  tool_search). They copy bytes; read/write of a PNG gives you garbled text
  and writes back a different file.
- A read-only loan refuses writes and file removal. Commands are not
  restricted by it, so do not use a shell command to write into a folder lent
  read-only: that is exactly what the user said not to do.
- The loan is one conversation's. Another agent's conversation does not see
  it.

## Giving one back (share_disconnect)

When you are done with a folder, disconnect it: { name: "proj" } — the
segment after /lend/, not a path.

Disconnecting ends the loan on the user's computer too, so anything you still
need from it must be copied into your machine first (share_download, or a
write into your own folder). It returns at once; if the desktop app does not
answer, the tool says the folder is still lent, and you can tell the user to
disconnect it from the information panel.

You do not have to disconnect: a loan also ends on its own. Do it when the
folder holds something private and the work is finished, or when the user
asks you to stop using it.

## What not to do

- Do not ask for a folder that is already lent: the context message lists
  them.
- Do not ask for a folder to be read that you could have the user attach to a
  message instead: a single file they can send is one drag, and no loan.
- Do not guess a lent folder's name from a path: use the name the
  announcement gave (/lend/<name>).
- Do not write into a lent folder anything the user did not ask for, and do
  not delete anything there. It is their disk, and the loan is not a licence
  to tidy it.
`;

/** Build the built-in folder-share skill definition. Content is embedded (no
 * filesystem), so it survives bundling and any working directory. */
export function folderShareSkill(): SkillDef {
  return {
    name: "folder-share",
    description:
      "Use this skill when the work needs files that are on the user's own " +
      "computer rather than in your machine: it asks them to lend a folder " +
      "(share_request) and gives one back when you are done " +
      "(share_disconnect). Neither tool is preloaded — find them with " +
      "tool_search.",
    source: "builtin",
    read: (relativePath) => {
      if (relativePath !== undefined) {
        // One file per built-in skill: no follow-up files exist. The message
        // mirrors the file-based skills' read error.
        return Promise.reject(
          new Error(`No such file in skill "folder-share": ${relativePath}`),
        );
      }
      return Promise.resolve(SKILL_MD);
    },
  };
}
