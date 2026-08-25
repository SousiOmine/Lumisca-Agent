import { join } from "node:path";
import { realpathSync } from "node:fs";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  discoverSkills,
  formatAvailableSkills,
  loadSkillContent,
} from "./discover.ts";
import { builtinSkills } from "./builtin/mod.ts";

/** A user skill named "web-browser" — the same name as the built-in one —
 * used by the precedence tests. A user skill with this name must shadow
 * the app-embedded skill. */
const USER_WEB_BROWSER = `---
name: web-browser
description: User's own browser skill.
---

# User browser skill

Do it my way.
`;

/** Fixture repository root with a `.git` marker and, optionally, a user
 * `web-browser` skill in `.agents/skills`. */
async function fixtureRoot(withUserBrowser: boolean): Promise<string> {
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-builtin-" }),
  );
  await Deno.mkdir(join(root, ".git"), { recursive: true });
  if (withUserBrowser) {
    const dir = join(root, ".agents", "skills", "web-browser");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "SKILL.md"), USER_WEB_BROWSER);
  }
  return root;
}

/** The built-in skills a browser-enabled session sees. */
function browserBuiltins() {
  return builtinSkills({ browser: true });
}

// --- the built-in registry ---------------------------------------------------

Deno.test("builtinSkills advertises web-browser when the browser is available", () => {
  const skills = browserBuiltins();
  assertEquals(skills.map((s) => s.name), ["web-browser"]);
  const skill = skills[0]!;
  assertEquals(skill.source, "builtin");
  assert(skill.description.includes("tool_search"));
  // Embedded skills have no filesystem location.
  assertEquals(skill.path, undefined);
  assertEquals(skill.dir, undefined);
  assertEquals(typeof skill.read, "function");
});

Deno.test("builtinSkills hides web-browser without a browser backend", () => {
  assertEquals(builtinSkills({ browser: false }), []);
});

// --- loading ----------------------------------------------------------------

Deno.test("loadSkillContent reads the embedded SKILL.md without a filesystem", () => {
  const [skill] = browserBuiltins();
  assert(skill !== undefined);
  const content = loadSkillContent(skill);
  // The guide's key teaching must be present.
  assert(content.includes("tool_search"));
  assert(content.includes("browser_open"));
  assert(content.includes("localhost"));
});

Deno.test("built-in skills have no follow-up files", async () => {
  const [skill] = browserBuiltins();
  assert(skill !== undefined);
  await assertRejects(
    () => Promise.resolve().then(() => loadSkillContent(skill, "reference.md")),
    Error,
    'No such file in skill "web-browser"',
  );
});

// --- precedence -------------------------------------------------------------

Deno.test("built-in skills fill gaps when no user skill exists", async () => {
  const root = await fixtureRoot(false);
  try {
    const skills = discoverSkills([root], {
      globalDirs: [],
      builtinSkills: browserBuiltins(),
    });
    const browser = skills.find((s) => s.name === "web-browser");
    assert(browser !== undefined);
    assertEquals(browser.source, "builtin");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("workspace skills shadow built-in skills of the same name", async () => {
  const root = await fixtureRoot(true);
  try {
    const skills = discoverSkills([root], {
      globalDirs: [],
      builtinSkills: browserBuiltins(),
    });
    const browser = skills.find((s) => s.name === "web-browser");
    assert(browser !== undefined);
    assertEquals(browser.source, "workspace");
    assertEquals(browser.description, "User's own browser skill.");
    // The shadowed built-in is not listed at all.
    assertEquals(
      skills.filter((s) => s.name === "web-browser").length,
      1,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("global skills shadow built-in skills of the same name", async () => {
  const root = await fixtureRoot(false);
  const global = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-builtin-global-" }),
  );
  try {
    const dir = join(global, "web-browser");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "SKILL.md"), USER_WEB_BROWSER);
    const skills = discoverSkills([root], {
      globalDirs: [global],
      builtinSkills: browserBuiltins(),
    });
    const browser = skills.find((s) => s.name === "web-browser");
    assert(browser !== undefined);
    assertEquals(browser.source, "global");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(global, { recursive: true });
  }
});

Deno.test("plugin skills shadow built-in skills of the same name", () => {
  const pluginSkill = {
    name: "web-browser",
    description: "Plugin's browser skill.",
    path: "/virtual/plugin/skills/web-browser/SKILL.md",
    dir: "/virtual/plugin/skills/web-browser",
    source: "plugin" as const,
  };
  const skills = discoverSkills([], {
    globalDirs: [],
    pluginSkills: [pluginSkill],
    builtinSkills: browserBuiltins(),
  });
  const browser = skills.find((s) => s.name === "web-browser");
  assert(browser !== undefined);
  assertEquals(browser.source, "plugin");
});

// --- formatting -------------------------------------------------------------

Deno.test("formatAvailableSkills lists built-in skills like any other", () => {
  const text = formatAvailableSkills(browserBuiltins());
  assert(text.startsWith("- web-browser:"));
  assert(text.includes("built-in web browser"));
});
