import { join } from "node:path";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { builtinSkills } from "../skills/builtin/mod.ts";
import { discoverSkills, type SkillDef } from "../skills/discover.ts";
import { createSkillTool } from "../skills/tool.ts";
import { makeRealTempDir, removeDirRetry, toolText } from "../test-utils.ts";
import { sessionSkills } from "./tool-pieces.ts";
import { createCodingTools } from "./toolsets.ts";

async function makeTool(): Promise<{
  root: string;
  skills: SkillDef[];
  tool: ReturnType<typeof createSkillTool>;
}> {
  const root = await makeRealTempDir("lumisca-skill-tool-");
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
  return { root, skills, tool: createSkillTool({ skills: () => skills }) };
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
    await removeDirRetry(root);
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
    await removeDirRetry(root);
  }
});

Deno.test("skill tool rejects unknown skill names", async () => {
  const { root, tool } = await makeTool();
  try {
    // execute may throw synchronously; wrap so assertRejects sees a rejection.
    await assertRejects(
      () =>
        Promise.resolve().then(() =>
          tool.execute("1", { name: "nope" }, undefined),
        ),
      Error,
      'Unknown skill "nope"',
    );
  } finally {
    await removeDirRetry(root);
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
          ),
        ),
      Error,
      "escapes",
    );
  } finally {
    await removeDirRetry(root);
  }
});

// --- built-in (app-embedded) skills ------------------------------------------

function makeBuiltinTool(browser: boolean) {
  return createSkillTool({
    skills: () => builtinSkills({ browser, computer: false, subagents: false }),
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
        ),
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
        tool.execute("1", { name: "web-browser" }, undefined),
      ),
    Error,
    'Unknown skill "web-browser"',
  );
});

// --- skills written during the session ---------------------------------------

Deno.test("skill tool resolves the catalog on every call", async () => {
  const root = await makeRealTempDir("lumisca-skill-tool-");
  try {
    const tool = createSkillTool({
      skills: () => discoverSkills([root], { globalDirs: [], appDirs: [] }),
    });
    // Nothing on disk yet: the name is unknown...
    await assertRejects(
      () =>
        Promise.resolve().then(() =>
          tool.execute("1", { name: "fresh" }, undefined),
        ),
      Error,
      'Unknown skill "fresh"',
    );
    // ...and after the file is written (the flow the skill-authoring guide
    // teaches: write SKILL.md), the same tool object can load it. A tool that
    // kept the array it was built with would answer "unknown" here while the
    // catalog already listed the skill.
    const dir = join(root, ".agents", "skills", "fresh");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "SKILL.md"),
      "---\nname: fresh\ndescription: Written during the session.\n---\n\n# Fresh\n",
    );
    const result = await tool.execute("2", { name: "fresh" }, undefined);
    assert(toolText(result).includes("# Fresh"));
    assertEquals(result.details?.dir, dir);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("coding tools reach the shared skills folder and the catalog lists it", async () => {
  const root = await makeRealTempDir("lumisca-skill-shared-");
  const shared = await makeRealTempDir("lumisca-skill-app-");
  try {
    const workspace = {
      id: "w",
      name: "project",
      folders: [root],
      createdAt: 0,
      chat: false,
    };
    const tools = createCodingTools(workspace, {
      appSkillDirs: [shared],
      globalSkillDirs: [],
    });
    const write = tools.find((tool) => tool.name === "write");
    assert(write !== undefined, "the coding set has write");
    const skillFile = join(shared, "release-notes", "SKILL.md");
    await write!.execute(
      "1",
      {
        path: skillFile,
        content:
          "---\nname: release-notes\ndescription: Write release notes.\n---\n\n# Release notes\n",
      },
      undefined,
    );
    // The write landed outside the workspace: the shared folder is an extra
    // sandbox root.
    assert((await Deno.stat(skillFile)).isFile);

    // ...and the session's discovery (the same call the catalog provider and
    // the skill tool make) lists and loads it.
    const skills = sessionSkills([root], {
      appSkillDirs: [shared],
      globalDirs: [],
      skillAuthoring: true,
    });
    const sharedSkill = skills.find((s) => s.name === "release-notes");
    assert(
      sharedSkill !== undefined,
      JSON.stringify(skills.map((s) => s.name)),
    );
    assertEquals(sharedSkill!.source, "app");
    assertEquals(sharedSkill!.path, skillFile);
    // A session with file tools is also given the guide that taught this.
    assert(skills.some((s) => s.name === "skill-authoring"));

    // A path outside the workspace and the shared folder is still refused.
    const outside = tools.find((tool) => tool.name === "read");
    await assertRejects(
      () =>
        outside!.execute(
          "2",
          { path: join(shared, "..", "elsewhere.txt") },
          undefined,
        ),
      Error,
      "outside the workspace",
    );
  } finally {
    await removeDirRetry(root);
    await removeDirRetry(shared);
  }
});
