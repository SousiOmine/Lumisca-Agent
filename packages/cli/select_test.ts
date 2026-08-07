import { assertEquals } from "@std/assert";
import { LumiscaCore } from "@lumisca/core";
import { getPromptFn, setPromptFn } from "./ui.ts";
import { pickWorkspace, selectFromList } from "./select.ts";

function withInputs(inputs: string[]) {
  let i = 0;
  setPromptFn(() => (i < inputs.length ? inputs[i++]! : null));
}

Deno.test("selectFromList picks by number", async () => {
  withInputs(["2"]);
  const result = await selectFromList("test", [
    { label: "a", value: 1 },
    { label: "b", value: 2 },
    { label: "c", value: 3 },
  ]);
  assertEquals(result, 2);
});

Deno.test("selectFromList searches then picks", async () => {
  withInputs(["b", "1"]);
  const result = await selectFromList("test", [
    { label: "alpha", value: "a" },
    { label: "bravo", value: "b" },
    { label: "charlie", value: "c" },
  ]);
  assertEquals(result, "b");
});

Deno.test("selectFromList returns null on empty input", async () => {
  withInputs([""]);
  const result = await selectFromList("test", [
    { label: "a", value: 1 },
  ]);
  assertEquals(result, null);
});

Deno.test("selectFromList uses custom searchable", async () => {
  // Custom search matches on a hidden field.
  withInputs(["x", "1"]);
  const result = await selectFromList(
    "test",
    [
      { label: "one", value: { id: 1 } },
      { label: "two", value: { id: 2 } },
    ],
    (v, q) => String(v.id).includes(q),
  );
  assertEquals(result?.id, 1);
});

Deno.test("selectFromList restores list after no matches", async () => {
  // "zzz" matches nothing -> list restored; then pick 1.
  withInputs(["zzz", "1"]);
  const result = await selectFromList("test", [
    { label: "one", value: 1 },
    { label: "two", value: 2 },
  ]);
  assertEquals(result, 1);
});

Deno.test("pickWorkspace creates a new workspace from the picker", async () => {
  const core = LumiscaCore.openInMemory();
  const root = await Deno.makeTempDir({ prefix: "lumisca-pick-" });
  const ws = await core.createWorkspace("existing", [root]);

  // With workspaces present, the create entry is the 2nd choice; then the
  // creation flow prompts for folders (comma separated) and a name.
  withInputs(["2", `${root},${root}`, "new-ws"]);
  const id = await pickWorkspace(core);
  assertEquals(id !== null, true);
  const created = core.getWorkspace(id!);
  assertEquals(created?.name, "new-ws");
  assertEquals(created!.id !== ws.id, true, "a new workspace is created");
  core.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test("pickWorkspace falls back to creation when none exist", async () => {
  const core = LumiscaCore.openInMemory();
  const root = await Deno.makeTempDir({ prefix: "lumisca-pick-" });

  withInputs([root, "first-ws"]);
  const id = await pickWorkspace(core);
  assertEquals(core.getWorkspace(id!)?.name, "first-ws");
  core.close();
  await Deno.remove(root, { recursive: true });
});

// Restore the real prompt for other tests.
setPromptFn(getPromptFn());
