import type { SkillDef } from "../discover.ts";

/**
 * The built-in "skill-authoring" skill: how to write a skill.
 *
 * There is deliberately no create_skill tool. A skill is a directory with a
 * SKILL.md, so the agent adds, changes and removes skills with the same file
 * tools it uses for everything else (`write`, `edit`, `list_dir`, and `bash`
 * for deletion). What the tools cannot say is where a skill belongs, what the
 * frontmatter must contain, and which folders are shared — that is this
 * guide.
 *
 * Advertised only where the file tools exist (BuiltinContext.skillAuthoring):
 * a chat session has no `write`, and a guide pointing at a tool the session
 * does not have is a dead end. The shared folder's path is injected because
 * it depends on the installation (and on the mode): code mode's shared folder
 * is the Lumisca skills folder next to the settings file, stella's is the
 * machine's own `/home/agent/.agents/skills`.
 */

/** The one-line description the catalog shows. */
export const SKILL_AUTHORING_NAME = "skill-authoring";

/** Build the built-in skill-authoring guide. `stella` selects the wording
 * for the machine (the session's files are inside the VM, so the shared
 * folder is the machine's, not the host's). */
export function skillAuthoringSkill(
  options: { sharedDir?: string; stella: boolean },
): SkillDef {
  return {
    name: SKILL_AUTHORING_NAME,
    description:
      "Writing a skill: the SKILL.md format, the session's own skills " +
      "folder and the shared folder every agent reads. Teaches creating, " +
      "changing and deleting skills with the file tools (write, edit, " +
      "list_dir, bash).",
    source: "builtin",
    read: (relativePath) => {
      if (relativePath !== undefined) {
        // One file per built-in skill: no follow-up files exist.
        return Promise.reject(
          new Error(
            `No such file in skill "${SKILL_AUTHORING_NAME}": ${relativePath}`,
          ),
        );
      }
      return Promise.resolve(body(options));
    },
  };
}

function body(options: { sharedDir?: string; stella: boolean }): string {
  const own = options.stella
    ? "the `.agents/skills` folder inside your working folder " +
      "(a relative path like `.agents/skills/release-notes/SKILL.md`)"
    : "the workspace's `.agents/skills` folder " +
      "(for example `MyRepo/.agents/skills/release-notes/SKILL.md`)";
  const ownScope = options.stella
    ? "Only you read this one: it is your own skill, on your machine."
    : "This one belongs to the project: every session that opens this " +
      "workspace sees it, and it is versioned with the repository.";
  const shared = options.sharedDir === undefined
    ? "this installation has none, so every skill you write belongs to the " +
      "session or the project that needs it."
    : `\`${options.sharedDir}\`. Every agent ` +
      `${options.stella ? "on this machine" : "of this mode"} reads it, so ` +
      "put a skill there when it is not about one project. Address it by " +
      `absolute path: it is not inside ${
        options.stella ? "your working folder" : "the workspace"
      }, and a relative path cannot name it.`;
  const sharedScope = options.sharedDir === undefined
    ? ""
    : options.stella
    ? "A skill there is read by every conversation on this machine. The " +
      "host's own `~/.agents/skills` is separate and read-only to you; do " +
      "not try to write there."
    : "A skill there is read by every session of this mode (a stella " +
      "conversation has its own machine and its own shared folder, so it " +
      "does not see this one). The user's own `~/.agents/skills` is " +
      "separate and read-only to you; do not try to write there.";

  return `# Authoring skills

A skill is a folder holding a \`SKILL.md\`: instructions you load with the
\`skill\` tool when its description matches the work. Writing one is the way
to keep a procedure for later instead of repeating it in every reply.

Use this guide when:

- the user asks you to add, change or remove a skill;
- the user says "remember how to do this", or you find yourself doing the
  same multi-step procedure for the third time and want it available next
  session.

## Where a skill lives

Two places are yours to write:

- **This session's own folder** — ${own}. ${ownScope}
- **The shared folder** — ${shared} ${sharedScope}

Precedence is: the session's own folder, then the shared folder, then the
user's global folder, then the built-in skills. A skill in a higher place
shadows a same-named one below it.

Choose by scope, not by convenience: a skill about this repository goes in
the workspace; a general procedure ("how I write release notes") goes in the
shared folder.

## The file

\`\`\`markdown
---
name: release-notes
description: Write release notes from merged pull requests. Use when the user asks for a release summary.
---

# Release notes

1. Read the merged pull requests since the last tag.
2. Group them by user-visible area.
3. Write one line per change, in the past tense.
\`\`\`

Rules discovery enforces:

- \`name\`: lowercase letters, digits and single hyphens, 1–64 characters.
  It MUST equal the folder name — a mismatch means the skill is ignored.
- \`description\`: one line, 1–1024 characters. It is the only thing the
  catalog shows, so say **when** to use the skill, not what it contains.
- The body: the instructions themselves. Write them for an agent that has
  your tools, in the imperative, and keep them short enough to read.

## Creating

1. \`write\` the full path (see "Where a skill lives"). The parent folders
   are created for you, and the file must start with the frontmatter block.
2. Add any reference file the skill needs next to SKILL.md (a longer
   checklist, a script) and name it in SKILL.md: the \`skill\` tool can read
   one file from the skill's folder with \`read_followup\`.
3. Say what you created and where.

The catalog picks the skill up for the next turn in code mode; in a stella
conversation it appears when the conversation is next opened. The composer's
\`/skill\` palette reads the same catalog, so the user can pick it too.

## Changing

- \`edit\` the file. Keep the frontmatter valid — a broken name or a missing
  description makes the whole skill disappear from the catalog.
- \`list_dir\` a skills folder to see what is already there before adding a
  name that might shadow an existing skill.
- Changing a skill you did not write: only when the user asked for it, and
  keep their intent. Their files are not yours to reorganise.

## Deleting

The file tools cannot delete. Use \`bash\`:

\`\`\`bash
rm -rf <the skill folder>
\`\`\`

Delete a skill you wrote when it is obsolete or the user asks. Do not delete
one you did not write unless the user asks for that one by name.

## Checklist before you answer

- The folder is named exactly like \`name\` in the frontmatter.
- \`description\` says when to use it.
- You chose workspace or shared by scope.
- You said where it went, and whether the user must reopen anything to see
  it.
`;
}
