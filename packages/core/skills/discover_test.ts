import { join } from "node:path";
import { realpathSync } from "node:fs";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  discoverSkills,
  formatAvailableSkills,
  loadSkillContent,
} from "./discover.ts";
import { parseSkillFrontmatter } from "./frontmatter.ts";

const VALID = `---
name: alpha
description: Alpha skill for testing.
---

# Alpha

Do the alpha thing.
`;

/** Fixture repository:
 * root/
 *   .git/
 *   .agents/skills/
 *     alpha/SKILL.md          (valid)
 *     Bad/SKILL.md            (frontmatter name "bad" ≠ dir name → skipped)
 *     no-fm/SKILL.md          (no frontmatter → skipped)
 *     broken/SKILL.md         (invalid YAML → skipped)
 *     long/SKILL.md           (description > 1024 chars → skipped)
 *   pkg/
 *     .agents/skills/
 *       nested/SKILL.md       (valid, nested level)
 */
async function fixture(): Promise<string> {
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-skills-" }),
  );
  await Deno.mkdir(join(root, ".git"), { recursive: true });

  const skill = (dir: string, content: string) =>
    Deno.mkdir(dir, { recursive: true }).then(() =>
      Deno.writeTextFile(join(dir, "SKILL.md"), content)
    );

  await skill(join(root, ".agents", "skills", "alpha"), VALID);
  await skill(
    join(root, ".agents", "skills", "Bad"),
    "---\nname: bad\ndescription: Mismatched name.\n---\n",
  );
  await skill(
    join(root, ".agents", "skills", "no-fm"),
    "# No frontmatter here\n",
  );
  await skill(
    join(root, ".agents", "skills", "broken"),
    "---\nname: [unclosed\ndescription: oops\n",
  );
  await skill(
    join(root, ".agents", "skills", "long"),
    `---\nname: long\ndescription: ${"x".repeat(1100)}\n---\n`,
  );
  await skill(
    join(root, "pkg", ".agents", "skills", "nested"),
    `---\nname: nested\ndescription: Nested skill.\n---\n`,
  );
  return root;
}

// --- frontmatter -------------------------------------------------------------

Deno.test("parseSkillFrontmatter accepts a valid frontmatter", () => {
  const meta = parseSkillFrontmatter(VALID);
  assertEquals(meta, {
    name: "alpha",
    description: "Alpha skill for testing.",
  });
});

Deno.test("parseSkillFrontmatter handles CRLF and colons in descriptions", () => {
  const meta = parseSkillFrontmatter(
    '---\r\nname: crlf-skill\r\ndescription: "Takes a path: resolves it."\r\n---\r\nbody',
  );
  assertEquals(meta?.name, "crlf-skill");
  assertEquals(meta?.description, "Takes a path: resolves it.");
});

Deno.test("parseSkillFrontmatter rejects files without frontmatter", () => {
  assertEquals(parseSkillFrontmatter("# plain markdown"), undefined);
  assertEquals(parseSkillFrontmatter(""), undefined);
});

Deno.test("parseSkillFrontmatter rejects invalid or missing fields", () => {
  assertEquals(
    parseSkillFrontmatter("---\nname: 123_bad\ndescription: ok\n---\n"),
    undefined,
  );
  assertEquals(
    parseSkillFrontmatter("---\nname: UPPER\ndescription: ok\n---\n"),
    undefined,
  );
  assertEquals(
    parseSkillFrontmatter("---\ndescription: no name here\n---\n"),
    undefined,
  );
  assertEquals(
    parseSkillFrontmatter("---\nname: x\ndescription: ''\n---\n"),
    undefined,
  );
  assertEquals(
    parseSkillFrontmatter("---\nname: x\ndescription: short\n---\n"),
    { name: "x", description: "short" },
  );
  assertEquals(
    parseSkillFrontmatter(
      `---\nname: ${"a".repeat(65)}\ndescription: too long name\n---\n`,
    ),
    undefined,
  );
});

// --- discovery ---------------------------------------------------------------

Deno.test("discoverSkills finds skills at every level up to the repo root", async () => {
  const root = await fixture();
  try {
    const skills = discoverSkills([join(root, "pkg")], { globalDirs: [] });
    const names = skills.map((s) => s.name).sort();
    assertEquals(names, ["alpha", "nested"]);
    const alpha = skills.find((s) => s.name === "alpha");
    assertEquals(alpha?.source, "workspace");
    assertEquals(
      alpha?.path,
      join(root, ".agents", "skills", "alpha", "SKILL.md"),
    );
    const nested = skills.find((s) => s.name === "nested");
    assertEquals(
      nested?.path,
      join(root, "pkg", ".agents", "skills", "nested", "SKILL.md"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("discoverSkills skips skills with invalid frontmatter or name mismatch", async () => {
  const root = await fixture();
  try {
    const skills = discoverSkills([root], { globalDirs: [] });
    const names = skills.map((s) => s.name);
    assertEquals(names.includes("Bad"), false);
    assertEquals(names.includes("no-fm"), false);
    assertEquals(names.includes("broken"), false);
    assertEquals(names.includes("long"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("workspace skills shadow global skills of the same name", async () => {
  const root = await fixture();
  const global = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-global-" }),
  );
  try {
    await Deno.mkdir(join(global, "alpha"), { recursive: true });
    await Deno.writeTextFile(
      join(global, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: Global alpha.\n---\n",
    );
    await Deno.mkdir(join(global, "global-only"), { recursive: true });
    await Deno.writeTextFile(
      join(global, "global-only", "SKILL.md"),
      "---\nname: global-only\ndescription: Only in global.\n---\n",
    );

    const skills = discoverSkills([root], { globalDirs: [global] });
    const alpha = skills.find((s) => s.name === "alpha");
    assertEquals(alpha?.source, "workspace");
    assertEquals(alpha?.description, "Alpha skill for testing.");
    const only = skills.find((s) => s.name === "global-only");
    assertEquals(only?.source, "global");
    assertEquals(only?.path, join(global, "global-only", "SKILL.md"));
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(global, { recursive: true });
  }
});

Deno.test("discoverSkills dedupes skills reachable from overlapping folders", async () => {
  const root = await fixture();
  try {
    const skills = discoverSkills([root, join(root, "pkg")], {
      globalDirs: [],
    });
    assertEquals(
      skills.filter((s) => s.name === "alpha").length,
      1,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- formatting / loading ----------------------------------------------------

Deno.test("formatAvailableSkills renders one line per skill", async () => {
  const root = await fixture();
  try {
    const text = formatAvailableSkills(
      discoverSkills([root], { globalDirs: [] }),
    );
    assert(text.includes("- alpha: Alpha skill for testing."));
    assert(text.startsWith("- alpha:"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadSkillContent reads SKILL.md and follow-up files", async () => {
  const root = await fixture();
  try {
    const [alpha] = discoverSkills([root], { globalDirs: [] });
    assert(alpha !== undefined);
    const content = loadSkillContent(alpha);
    assert(content.includes("# Alpha"));
    // Follow-up file inside the skill directory.
    await Deno.writeTextFile(join(alpha.dir, "reference.md"), "# Reference\n");
    assertEquals(loadSkillContent(alpha, "reference.md"), "# Reference\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadSkillContent rejects paths escaping the skill directory", async () => {
  const root = await fixture();
  try {
    const [alpha] = discoverSkills([root], { globalDirs: [] });
    assert(alpha !== undefined);
    await assertRejects(
      () =>
        Promise.resolve().then(() => loadSkillContent(alpha, "../secret.txt")),
      Error,
      "escapes",
    );
    await assertRejects(
      () =>
        Promise.resolve().then(() =>
          loadSkillContent(alpha, join(root, "secret.txt"))
        ),
      Error,
      "not relative",
    );
    await assertRejects(
      () => Promise.resolve().then(() => loadSkillContent(alpha, "missing.md")),
      Error,
      "No such file",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
