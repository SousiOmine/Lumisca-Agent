import { assertEquals } from "@std/assert";
import { LumiscaCore } from "@lumisca/core";
import { withPromptFn } from "./ui.ts";
import { pickModel, pickWorkspace, selectFromList } from "./select.ts";

/** Feed the given inputs in order; anything beyond the list returns null. */
function withInputs<T>(inputs: string[], body: () => Promise<T>): Promise<T> {
  let i = 0;
  return withPromptFn(() => (i < inputs.length ? inputs[i++]! : null), body);
}

Deno.test("selectFromList picks by number", () =>
  withInputs(["2"], async () => {
    const result = await selectFromList("test", [
      { label: "a", value: 1 },
      { label: "b", value: 2 },
      { label: "c", value: 3 },
    ]);
    assertEquals(result, 2);
  }));

Deno.test("selectFromList searches then picks", () =>
  withInputs(["b", "1"], async () => {
    const result = await selectFromList("test", [
      { label: "alpha", value: "a" },
      { label: "bravo", value: "b" },
      { label: "charlie", value: "c" },
    ]);
    assertEquals(result, "b");
  }));

Deno.test("selectFromList returns null on empty input", () =>
  withInputs([""], async () => {
    const result = await selectFromList("test", [
      { label: "a", value: 1 },
    ]);
    assertEquals(result, null);
  }));

Deno.test("selectFromList uses custom searchable", () =>
  withInputs(["x", "1"], async () => {
    // Custom search matches on a hidden field.
    const result = await selectFromList(
      "test",
      [
        { label: "one", value: { id: 1 } },
        { label: "two", value: { id: 2 } },
      ],
      (v, q) => String(v.id).includes(q),
    );
    assertEquals(result?.id, 1);
  }));

Deno.test("selectFromList restores list after no matches", () =>
  withInputs(["zzz", "1"], async () => {
    // "zzz" matches nothing -> list restored; then pick 1.
    const result = await selectFromList("test", [
      { label: "one", value: 1 },
      { label: "two", value: 2 },
    ]);
    assertEquals(result, 1);
  }));

Deno.test("pickWorkspace creates a new workspace from the picker", async () => {
  const core = LumiscaCore.openInMemory();
  const root = await Deno.makeTempDir({ prefix: "lumisca-pick-" });
  const ws = await core.createWorkspace("existing", [root]);

  // With workspaces present, the create entry is the 2nd choice; then the
  // creation flow prompts for folders (comma separated) and a name.
  await withInputs(["2", `${root},${root}`, "new-ws"], async () => {
    const id = await pickWorkspace(core);
    assertEquals(id !== null, true);
    const created = core.getWorkspace(id!);
    assertEquals(created?.name, "new-ws");
    assertEquals(created!.id !== ws.id, true, "a new workspace is created");
  });
  core.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test("pickWorkspace falls back to creation when none exist", async () => {
  const core = LumiscaCore.openInMemory();
  const root = await Deno.makeTempDir({ prefix: "lumisca-pick-" });

  await withInputs([root, "first-ws"], async () => {
    const id = await pickWorkspace(core);
    assertEquals(core.getWorkspace(id!)?.name, "first-ws");
  });
  core.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test("pickModel offers only providers configured in Lumisca and enabled models", async () => {
  const core = LumiscaCore.openInMemory();
  const faux = (await import("@earendil-works/pi-ai")).fauxProvider();
  core.models.models.setProvider(faux.provider);
  // pickModel only offers providers explicitly configured in Lumisca.
  await core.setProviderApiKey(faux.provider.id, "test-key");

  // Provider search input ("faux") then "1" selects it; model search
  // ("faux-1") then "1" selects it.
  await withInputs(["faux", "1", "faux-1", "1"], async () => {
    const picked = await pickModel(core);
    assertEquals(picked?.providerId, faux.provider.id);
    assertEquals(picked?.modelId, faux.getModel().id);
  });
  core.close();
});
