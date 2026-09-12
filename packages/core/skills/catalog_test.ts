import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { makeRealTempDir, removeDirRetry } from "../test-utils.ts";
import { createSkillCatalogProvider } from "./catalog.ts";

/** A workspace root with one skill file of the given description. */
async function writeSkill(
  root: string,
  name: string,
  description: string,
): Promise<void> {
  const dir = join(root, ".agents", "skills", name);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`,
  );
}

/** A provider over a fixture workspace and an empty global directory: the
 * catalog is then exactly the fixture's skills, so assertions do not depend
 * on the developer's own ~/.agents/skills. */
async function fixture(): Promise<{
  root: string;
  globals: string;
  provider: ReturnType<typeof createSkillCatalogProvider>;
}> {
  const root = await makeRealTempDir("lumisca-catalog-");
  const globals = await makeRealTempDir("lumisca-globals-");
  return {
    root,
    globals,
    provider: createSkillCatalogProvider({
      folders: [root],
      globalDirs: [globals],
    }),
  };
}

Deno.test("skill catalog is published once and stays quiet while unchanged", async () => {
  const { root, globals, provider } = await fixture();
  try {
    await writeSkill(root, "demo", "A demo skill.");

    const first = provider.next();
    assertEquals(first.length, 1);
    assertEquals(first[0]!.title, "Skills (1 available)");
    assertStringIncludes(first[0]!.body, "<available_skills>");
    assertStringIncludes(first[0]!.body, "- demo: A demo skill.");
    assertEquals(first[0]!.state, { text: "- demo: A demo skill." });

    // Unchanged → nothing to publish (the transcript already carries it).
    assertEquals(provider.next(), []);
  } finally {
    await removeDirRetry(root);
    await removeDirRetry(globals);
  }
});

Deno.test("skill catalog republishes when a skill changes on disk", async () => {
  const { root, globals, provider } = await fixture();
  try {
    await writeSkill(root, "demo", "First description.");
    const first = provider.next()[0]!;

    await writeSkill(root, "demo", "Second description.");
    const update = provider.next();
    assertEquals(update.length, 1);
    assertEquals(update[0]!.title, "Skills (1 available)");
    assertStringIncludes(update[0]!.body, "replaces the earlier one");
    assertStringIncludes(update[0]!.body, "- demo: Second description.");
    assertEquals(first.state, { text: "- demo: First description." });
  } finally {
    await removeDirRetry(root);
    await removeDirRetry(globals);
  }
});

Deno.test("a rebased catalog is not republished, an unrebasable one is", async () => {
  const { root, globals, provider } = await fixture();
  try {
    await writeSkill(root, "demo", "A demo skill.");
    const published = provider.next()[0]!;

    // A reopened session restores the state from the transcript: the value
    // is already in history, so nothing is published.
    provider.rebase(published.state);
    assertEquals(provider.next(), []);

    // A rewind that dropped the message leaves no state: the next run
    // publishes the value again, framed as a fresh catalog (nothing in the
    // history claims to be replaced).
    provider.rebase(undefined);
    const again = provider.next();
    assertEquals(again.length, 1);
    assertStringIncludes(again[0]!.body, "- demo: A demo skill.");
    assertEquals(again[0]!.body.includes("replaces the earlier one"), false);
  } finally {
    await removeDirRetry(root);
    await removeDirRetry(globals);
  }
});

Deno.test("an emptied catalog is announced once", async () => {
  const { root, globals, provider } = await fixture();
  try {
    await writeSkill(root, "demo", "A demo skill.");
    provider.next();

    await Deno.remove(join(root, ".agents"), { recursive: true });
    const update = provider.next();
    assertEquals(update.length, 1);
    assertEquals(update[0]!.title, "Skills (none available)");
    assertEquals(provider.next(), []);
  } finally {
    await removeDirRetry(root);
    await removeDirRetry(globals);
  }
});

Deno.test("a session without skills publishes nothing", async () => {
  const { root, globals, provider } = await fixture();
  try {
    assertEquals(provider.next(), []);
  } finally {
    await removeDirRetry(root);
    await removeDirRetry(globals);
  }
});
