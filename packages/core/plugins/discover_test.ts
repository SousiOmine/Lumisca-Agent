import { join } from "node:path";
import { realpathSync } from "node:fs";
import { assert, assertEquals } from "@std/assert";
import { discoverPlugins } from "./discover.ts";
import { PLUGIN_SCHEMA_URL } from "./manifest.ts";
import { discoverSkills } from "../skills/discover.ts";

const SKILL = (name: string) =>
  `---
name: ${name}
description: ${name} skill.
---

# ${name}
`;

const MANIFEST = (name: string) =>
  JSON.stringify({
    $schema: PLUGIN_SCHEMA_URL,
    name,
    description: `Plugin ${name}`,
  });

/** Fixture repository:
 * root/
 *   .git/
 *   .agents/plugins/
 *     demo/plugin.json     (valid: name "demo")
 *     demo/skills/alpha/SKILL.md      (valid)
 *     demo/skills/Bad/SKILL.md        (name mismatch → skipped)
 *     demo/skills/nested/deep/SKILL.md (nested → not discovered)
 *     demo/mcp.json        (one stdio server "demo-server")
 *     broken/plugin.json   (invalid name → rejected)
 *     empty/               (no plugin.json → not a plugin)
 *     badskills/plugin.json + badskills/skills (a file → skills disabled)
 *     badmcp/plugin.json + badmcp/mcp.json (a directory → MCP disabled)
 *   .agents/skills/        (workspace skills for precedence tests)
 */
async function fixture(): Promise<string> {
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-plugins-" }),
  );
  await Deno.mkdir(join(root, ".git"), { recursive: true });

  const writeAt = (rel: string, content: string) =>
    Deno.mkdir(join(root, rel, ".."), { recursive: true })
      .then(() => Deno.writeTextFile(join(root, rel), content));

  const plugins = join(root, ".agents", "plugins");
  await Deno.mkdir(plugins, { recursive: true });

  await writeAt(
    join(".agents", "plugins", "demo", "plugin.json"),
    MANIFEST("demo"),
  );
  await writeAt(
    join(".agents", "plugins", "demo", "skills", "alpha", "SKILL.md"),
    SKILL("alpha"),
  );
  // Same name as a workspace skill: the workspace one must win.
  await writeAt(
    join(".agents", "plugins", "demo", "skills", "shared", "SKILL.md"),
    SKILL("shared"),
  );
  await writeAt(
    join(".agents", "plugins", "demo", "skills", "Bad", "SKILL.md"),
    "---\nname: bad\ndescription: Mismatched.\n---\n",
  );
  await writeAt(
    join(".agents", "plugins", "demo", "skills", "nested", "deep", "SKILL.md"),
    SKILL("deep"),
  );
  await writeAt(
    join(".agents", "plugins", "demo", "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        "demo-server": { type: "stdio", command: "./bin/server" },
      },
    }),
  );

  await writeAt(
    join(".agents", "plugins", "broken", "plugin.json"),
    JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: "Bad Name" }),
  );
  await Deno.mkdir(join(plugins, "empty"), { recursive: true });
  await writeAt(
    join(".agents", "plugins", "badskills", "plugin.json"),
    MANIFEST("badskills"),
  );
  await Deno.writeTextFile(join(plugins, "badskills", "skills"), "not a dir");
  await writeAt(
    join(".agents", "plugins", "badmcp", "plugin.json"),
    MANIFEST("badmcp"),
  );
  await Deno.mkdir(join(plugins, "badmcp", "mcp.json"), { recursive: true });

  // Workspace skills for the precedence tests.
  await writeAt(
    join(".agents", "skills", "ws-only", "SKILL.md"),
    SKILL("ws-only"),
  );
  await writeAt(
    join(".agents", "skills", "shared", "SKILL.md"),
    SKILL("shared"),
  );
  return root;
}

async function globalFixture(): Promise<
  { dir: string; pluginDir: string; skillsDir: string }
> {
  const dir = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-global-" }),
  );
  const pluginDir = join(dir, ".agents", "plugins");
  const skillsDir = join(dir, ".agents", "skills");
  await Deno.mkdir(pluginDir, { recursive: true });
  await Deno.mkdir(skillsDir, { recursive: true });

  const writeAt = (rel: string, content: string) =>
    Deno.mkdir(join(dir, rel, ".."), { recursive: true })
      .then(() => Deno.writeTextFile(join(dir, rel), content));

  // Same name as the workspace plugin: the workspace one must win.
  await writeAt(
    join(".agents", "plugins", "demo", "plugin.json"),
    MANIFEST("demo"),
  );
  await writeAt(
    join(".agents", "plugins", "global-only", "plugin.json"),
    MANIFEST("global-only"),
  );
  await writeAt(
    join(
      ".agents",
      "plugins",
      "global-only",
      "skills",
      "plugin-only",
      "SKILL.md",
    ),
    SKILL("plugin-only"),
  );
  await writeAt(
    join(".agents", "skills", "shared", "SKILL.md"),
    SKILL("shared"),
  );
  await writeAt(
    join(".agents", "skills", "plugin-only", "SKILL.md"),
    SKILL("plugin-only"),
  );
  await writeAt(
    join(".agents", "skills", "global-only", "SKILL.md"),
    SKILL("global-only"),
  );
  return { dir, pluginDir, skillsDir };
}

// --- discovery ---------------------------------------------------------------

Deno.test("discoverPlugins finds plugins with skills and MCP servers", async () => {
  const root = await fixture();
  const dataRoot = await Deno.makeTempDir({ prefix: "lumisca-data-" });
  const plugins = discoverPlugins([root], { pluginDataRoot: dataRoot });

  const demo = plugins.find((p) => p.name === "demo");
  assert(demo, "demo plugin should be discovered");
  assertEquals(demo.root, join(root, ".agents", "plugins", "demo"));
  assertEquals(demo.manifest?.description, "Plugin demo");
  assertEquals(demo.skills.map((s) => s.name), ["alpha", "shared"]);
  assertEquals(demo.skills[0]!.source, "plugin");
  assertEquals(
    demo.skills[0]!.dir,
    join(root, ".agents", "plugins", "demo", "skills", "alpha"),
  );
  assertEquals(demo.mcpServers.map((s) => s.name), ["demo-server"]);
  assertEquals(demo.mcpServers[0]!.cwd, demo.root);
  // PLUGIN_DATA for the stdio server lives under the data root.
  assert(Deno.statSync(join(dataRoot, "demo")).isDirectory);
  assertEquals(demo.warnings, []);
});

Deno.test("discoverPlugins skips directories without a plugin.json", async () => {
  const root = await fixture();
  const plugins = discoverPlugins([root]);
  assertEquals(plugins.find((p) => p.name === "empty"), undefined);
});

Deno.test("discoverPlugins rejects plugins with fatal manifests", async () => {
  const root = await fixture();
  const plugins = discoverPlugins([root]);
  const broken = plugins.find((p) => p.name === "broken");
  assert(broken, "rejected plugin should surface for reporting");
  assertEquals(broken.manifest, undefined);
  assertEquals(broken.skills, []);
  assertEquals(broken.mcpServers, []);
  assert(broken.warnings[0]!.includes("Plugin rejected"));
  assert(broken.warnings[0]!.includes("name"));
});

Deno.test("discoverPlugins does not recurse into nested skill directories", async () => {
  const root = await fixture();
  const plugins = discoverPlugins([root]);
  const demo = plugins.find((p) => p.name === "demo")!;
  // "deep" (nested two levels) is absent; only direct children count.
  assertEquals(demo.skills.map((s) => s.name), ["alpha", "shared"]);
});

Deno.test("discoverPlugins isolates wrong-kinded component locations", async () => {
  const root = await fixture();
  const plugins = discoverPlugins([root]);
  const badskills = plugins.find((p) => p.name === "badskills")!;
  assertEquals(badskills.skills, []);
  assert(
    badskills.warnings.some((w) => w.includes('"skills" is not a directory')),
  );
  const badmcp = plugins.find((p) => p.name === "badmcp")!;
  assertEquals(badmcp.mcpServers, []);
  assert(badmcp.warnings.some((w) => w.includes('"mcp.json" is not a file')));
  // Other plugins are unaffected.
  assert(plugins.some((p) => p.name === "demo"));
});

Deno.test("discoverPlugins appends global plugins after workspace ones", async () => {
  const root = await fixture();
  const globals = await globalFixture();
  const plugins = discoverPlugins([root], { globalDirs: [globals.pluginDir] });

  // "demo" exists in both: the workspace plugin wins.
  const demo = plugins.filter((p) => p.name === "demo");
  assertEquals(demo.length, 1);
  assertEquals(demo[0]!.root, join(root, ".agents", "plugins", "demo"));
  assert(plugins.some((p) => p.name === "global-only"));
});

// --- skill precedence --------------------------------------------------------

Deno.test("plugin skills merge after workspace skills and before global ones", async () => {
  const root = await fixture();
  const globals = await globalFixture();
  const plugins = discoverPlugins([root], { globalDirs: [globals.pluginDir] });
  const pluginSkills = plugins.flatMap((p) => p.skills);
  const skills = discoverSkills([root], {
    pluginSkills,
    globalDirs: [globals.skillsDir],
  });

  const byName = new Map(skills.map((s) => [s.name, s]));
  // Workspace skill shadows the same-named plugin skill ("shared" exists
  // in the demo plugin, but the workspace one wins here).
  assertEquals(byName.get("shared")!.source, "workspace");
  // Plugin skill shadows the same-named global skill.
  assertEquals(byName.get("plugin-only")!.source, "plugin");
  // Uncontested skills keep their sources.
  assertEquals(byName.get("ws-only")!.source, "workspace");
  assertEquals(byName.get("global-only")!.source, "global");
  // Order: workspace, then plugin, then global.
  assertEquals(
    skills.map((s) => s.source),
    ["workspace", "workspace", "plugin", "plugin", "global"],
  );
});
