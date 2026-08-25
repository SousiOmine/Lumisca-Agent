import { join } from "node:path";
import { realpathSync } from "node:fs";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createSkillTool } from "../skills/tool.ts";
import { discoverSkills, type SkillDef } from "../skills/discover.ts";
import { builtinSkills } from "../skills/builtin/mod.ts";

function toolText(
  result: { content: { type: "text" | "image"; text?: string }[] },
): string {
  return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("");
}

async function makeTool(): Promise<
  { root: string; skills: SkillDef[]; tool: ReturnType<typeof createSkillTool> }
> {
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-skill-tool-" }),
  );
  await Deno.mkdir(join(root, ".agents", "skills", "demo"), {
    recursive: true,
  });
  await Deno.writeTextFile(
    join(root, ".agents", "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: Demo skill.\n---\n\n# Demo\n\nDo the demo.\n",
  );
  await Deno.writeTextFile(
    join(root, ".agents", "skills", "demo", "reference.md"),
    "# Reference\nDetails.\n",
  );
  const skills = discoverSkills([root], { globalDirs: [] });
  return { root, skills, tool: createSkillTool({ skills }) };
}

Deno.test("skill tool loads SKILL.md content for a known skill", async () => {
  const { root, skills, tool } = await makeTool();
  try {
    assertEquals(skills.length, 1);
    const result = await tool.execute("1", { name: "demo" }, undefined);
    assert(toolText(result).includes("# Demo"));
    assertEquals(result.details?.name, "demo");
    assertEquals(
      result.details?.path,
      join(root, ".agents", "skills", "demo", "SKILL.md"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("skill tool reads a follow-up file from the skill directory", async () => {
  const { root, tool } = await makeTool();
  try {
    const result = await tool.execute(
      "1",
      { name: "demo", read_followup: "reference.md" },
      undefined,
    );
    assertEquals(toolText(result), "# Reference\nDetails.\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("skill tool rejects unknown skill names", async () => {
  const { root, tool } = await makeTool();
  try {
    // execute may throw synchronously; wrap so assertRejects sees a rejection.
    await assertRejects(
      () =>
        Promise.resolve().then(() =>
          tool.execute("1", { name: "nope" }, undefined)
        ),
      Error,
      'Unknown skill "nope"',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("skill tool rejects follow-up reads that escape the skill directory", async () => {
  const { root, tool } = await makeTool();
  try {
    await assertRejects(
      () =>
        Promise.resolve().then(() =>
          tool.execute(
            "1",
            { name: "demo", read_followup: "../secret.txt" },
            undefined,
          )
        ),
      Error,
      "escapes",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- built-in (app-embedded) skills ------------------------------------------

function makeBuiltinTool(browser: boolean) {
  return createSkillTool({
    skills: builtinSkills({ browser }),
  });
}

Deno.test("skill tool loads a built-in skill without a filesystem", async () => {
  const tool = makeBuiltinTool(true);
  const result = await tool.execute("1", { name: "web-browser" }, undefined);
  assert(toolText(result).includes("tool_search"));
  assertEquals(result.details?.name, "web-browser");
  // Embedded skills report no path/dir.
  assertEquals(result.details?.path, undefined);
  assertEquals(result.details?.dir, undefined);
});

Deno.test("skill tool rejects follow-up reads on a built-in skill", async () => {
  const tool = makeBuiltinTool(true);
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        tool.execute(
          "1",
          { name: "web-browser", read_followup: "reference.md" },
          undefined,
        )
      ),
    Error,
    'No such file in skill "web-browser"',
  );
});

Deno.test("skill tool hides built-in skills when their capability is absent", async () => {
  const tool = makeBuiltinTool(false);
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        tool.execute("1", { name: "web-browser" }, undefined)
      ),
    Error,
    'Unknown skill "web-browser"',
  );
});
