import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { makeRealTempDir, removeDirRetry } from "../test-utils.ts";
import { createInstructionsProvider } from "./instructions.ts";

/** A provider over a fixture workspace: `root` (with a .git marker, so the
 * instruction chain stops there) plus a nested `sub` folder, so both
 * directories are on the chain and can carry their own AGENTS.md. */
async function fixture(personal?: () => { path: string; content: string }) {
  const root = await makeRealTempDir("lumisca-instructions-");
  await Deno.mkdir(join(root, ".git"), { recursive: true });
  const sub = join(root, "sub");
  await Deno.mkdir(sub, { recursive: true });
  const provider = createInstructionsProvider({
    folders: [root, sub],
    personal,
  });
  return { root, sub, provider };
}

Deno.test("instructions are published as a baseline once, then stay quiet", async () => {
  const { root, provider } = await fixture();
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "Use Deno.\n");

    const first = provider.next();
    assertEquals(first.length, 1);
    assertEquals(first[0]!.title, "Workspace instructions (1)");
    assertStringIncludes(
      first[0]!.body,
      "This complete workspace instruction baseline replaces all earlier",
    );
    assertStringIncludes(
      first[0]!.body,
      `Instructions from: ${join(root, "AGENTS.md")}`,
    );
    assertStringIncludes(first[0]!.body, "Use Deno.");

    // Unchanged → nothing to publish.
    assertEquals(provider.next(), []);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("an edited instruction file is republished as an update", async () => {
  const { root, provider } = await fixture();
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "Use Deno 2.\n");
    provider.next();

    await Deno.writeTextFile(join(root, "AGENTS.md"), "Use Deno 3.\n");
    const update = provider.next();
    assertEquals(update.length, 1);
    assertStringIncludes(update[0]!.title, "Instructions updated:");
    assertStringIncludes(update[0]!.body, "Updated instructions from:");
    assertStringIncludes(update[0]!.body, "Use Deno 3.");
    assertEquals(
      update[0]!.body.includes("Use Deno 2."),
      false,
      "the superseded content must not be resent",
    );

    // The new content is now the baseline the provider tracks.
    assertEquals(provider.next(), []);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("a removed instruction file is announced as removed", async () => {
  const { root, provider } = await fixture();
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "Use Deno.\n");
    provider.next();

    await Deno.remove(join(root, "AGENTS.md"));
    const update = provider.next();
    assertEquals(update.length, 1);
    assertStringIncludes(update[0]!.body, "Instructions removed:");
    assertStringIncludes(
      update[0]!.body,
      "The previously loaded instructions from this file no longer apply.",
    );
    assertEquals(provider.next(), []);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("a new instruction file is announced as additional", async () => {
  const { root, sub, provider } = await fixture();
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "Root.\n");
    provider.next();

    await Deno.writeTextFile(join(sub, "AGENTS.md"), "Nested.\n");
    const update = provider.next();
    assertEquals(update.length, 1);
    assertStringIncludes(update[0]!.body, "Additional instructions from:");
    assertStringIncludes(update[0]!.body, "Nested.");
    // The unchanged file is not resent: only the new file's block rides along.
    assertEquals(update[0]!.body.includes("Root."), false);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("one update carries every change of a turn", async () => {
  const { root, sub, provider } = await fixture();
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "Root.\n");
    await Deno.writeTextFile(join(sub, "AGENTS.md"), "Nested.\n");
    provider.next();

    await Deno.writeTextFile(join(root, "AGENTS.md"), "Root 2.\n");
    await Deno.writeTextFile(join(sub, "AGENTS.md"), "Nested 2.\n");

    const update = provider.next();
    assertEquals(update.length, 1, "one message per turn");
    assertStringIncludes(update[0]!.body, "Updated instructions from:");
    assertStringIncludes(update[0]!.body, "Root 2.");
    assertStringIncludes(update[0]!.body, "Nested 2.");
    assertStringIncludes(update[0]!.title, "2 files");
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("a rebased provider does not republish unchanged instructions", async () => {
  const { root, provider } = await fixture();
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "Use Deno.\n");
    const published = provider.next()[0]!;

    provider.rebase(published.state);
    assertEquals(provider.next(), []);

    // A transcript without the baseline (a rewind removed it) republishes.
    provider.rebase(undefined);
    const again = provider.next();
    assertEquals(again.length, 1);
    assertStringIncludes(again[0]!.body, "Use Deno.");
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("a reopened session reports what changed while it was closed", async () => {
  const { root, provider } = await fixture();
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "Old.\n");
    const published = provider.next()[0]!;

    // The session closes; the file changes; a new agent rebases from the
    // stored transcript state.
    await Deno.writeTextFile(join(root, "AGENTS.md"), "New.\n");
    const reopened = createInstructionsProvider({ folders: [root] });
    reopened.rebase(published.state);
    const update = reopened.next();
    assertEquals(update.length, 1);
    assertStringIncludes(update[0]!.body, "Updated instructions from:");
    assertStringIncludes(update[0]!.body, "New.");
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("a session without instructions publishes nothing", async () => {
  const { root, provider } = await fixture();
  try {
    assertEquals(provider.next(), []);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("personal instructions ride along with the workspace ones", async () => {
  const dir = await makeRealTempDir("lumisca-personal-");
  const personalPath = join(dir, "AGENTS.md");
  await Deno.writeTextFile(personalPath, "Answer in Japanese.\n");
  const { root, provider } = await fixture(() => ({
    path: personalPath,
    content: Deno.readTextFileSync(personalPath),
  }));
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "Workspace.\n");
    const [baseline] = provider.next();
    assertEquals(baseline!.title, "Workspace instructions (2)");
    assertStringIncludes(baseline!.body, `Instructions from: ${personalPath}`);
    assertStringIncludes(baseline!.body, "Answer in Japanese.");

    // An edit to the personal file is an update like any other.
    await Deno.writeTextFile(personalPath, "Answer in English.\n");
    const update = provider.next();
    assertEquals(update.length, 1);
    assertStringIncludes(update[0]!.body, "Updated instructions from:");
    assertStringIncludes(update[0]!.body, "Answer in English.");
  } finally {
    await removeDirRetry(root);
    await removeDirRetry(dir);
  }
});
