import { makeRealTempDir, removeDirRetry } from "../test-utils.ts";
import { join } from "node:path";
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
  const root = await makeRealTempDir("lumisca-builtin-");
  await Deno.mkdir(join(root, ".git"), { recursive: true });
  if (withUserBrowser) {
    const dir = join(root, ".agents", "skills", "web-browser");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "SKILL.md"), USER_WEB_BROWSER);
  }
  return root;
}

/** The built-in skills a browser-enabled session sees (computer use off). */
function browserBuiltins() {
  return builtinSkills({ browser: true, computer: false, subagents: false });
}

/** The built-in skills a session that may drive this machine sees. */
function computerBuiltins() {
  return builtinSkills({ browser: false, computer: true, subagents: false });
}

// --- the built-in registry ---------------------------------------------------

Deno.test("builtinSkills advertises the stella-only skills for a stella session", async () => {
  const skills = builtinSkills({
    browser: false,
    computer: false,
    stella: true,
    subagents: false,
  });
  assertEquals(skills.map((s) => s.name), ["agent-create", "identity"]);

  // Each guide teaches the tool_search → tool_call path, because neither
  // tool is preloaded (they live in the session's main registry).
  const agentCreate = skills[0]!;
  assert(agentCreate.description.includes("tool_search"));
  const identity = skills[1]!;
  assert(identity.description.includes("tool_search"));

  const agentGuide = await loadSkillContent(agentCreate);
  assert(agentGuide.includes("agent_create"));
  assert(agentGuide.includes("tool_search"));
  assert(agentGuide.includes("chat_ui"));

  const identityGuide = await loadSkillContent(identity);
  assert(identityGuide.includes("identity"));
  assert(identityGuide.includes("tool_search"));
  // The one thing the tool's own description cannot carry: what to keep out
  // of the text.
  assert(identityGuide.includes("Secrets"));
  // And when a write lands (the next run), so the model does not assume it
  // failed.
  assert(identityGuide.includes("next run"));

  // A code-mode session has no agents to manage: neither skill is offered.
  assertEquals(
    builtinSkills({ browser: false, computer: false, subagents: false }).some((
      s,
    ) => s.name === "agent-create" || s.name === "identity"),
    false,
  );
});

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
  assertEquals(
    builtinSkills({ browser: false, computer: false, subagents: false }),
    [],
  );
});

Deno.test("builtinSkills advertises computer-use only when the machine can be driven", () => {
  const skills = computerBuiltins();
  assertEquals(skills.map((s) => s.name), ["computer-use"]);
  const skill = skills[0]!;
  assertEquals(skill.source, "builtin");
  assert(skill.description.includes("tool_search"));
  assert(skill.description.includes("Windows and Linux (Wayland)"));
  assertEquals(skill.path, undefined);
  assertEquals(typeof skill.read, "function");

  // A session that must not drive the machine never sees the skill.
  assertEquals(
    builtinSkills({ browser: false, computer: false, subagents: false }),
    [],
  );
  assertEquals(browserBuiltins().some((s) => s.name === "computer-use"), false);
});

Deno.test("both built-in skills are advertised when both capabilities are present", () => {
  assertEquals(
    builtinSkills({ browser: true, computer: true, subagents: false }).map((
      s,
    ) => s.name),
    ["web-browser", "computer-use"],
  );
});

Deno.test("loadSkillContent reads the embedded computer-use guide", async () => {
  const [skill] = computerBuiltins();
  assert(skill !== undefined);
  const content = await loadSkillContent(skill);
  // The guide's key teaching must be present.
  assert(content.includes("tool_search"));
  assert(content.includes("computer_screenshot"));
  assert(content.includes("computer_act"));
  assert(content.includes("no screenshot yet"));
});

Deno.test("the computer-use guide has no follow-up files", async () => {
  const [skill] = computerBuiltins();
  assert(skill !== undefined);
  await assertRejects(
    () => loadSkillContent(skill, "reference.md"),
    Error,
    'No such file in skill "computer-use"',
  );
});

// --- loading ----------------------------------------------------------------

Deno.test("loadSkillContent reads the embedded SKILL.md without a filesystem", async () => {
  const [skill] = browserBuiltins();
  assert(skill !== undefined);
  const content = await loadSkillContent(skill);
  // The guide's key teaching must be present.
  assert(content.includes("tool_search"));
  assert(content.includes("browser_open"));
  assert(content.includes("localhost"));
});

Deno.test("built-in skills have no follow-up files", async () => {
  const [skill] = browserBuiltins();
  assert(skill !== undefined);
  await assertRejects(
    () => loadSkillContent(skill, "reference.md"),
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
    await removeDirRetry(root);
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
    await removeDirRetry(root);
  }
});

Deno.test("global skills shadow built-in skills of the same name", async () => {
  const root = await fixtureRoot(false);
  const global = await makeRealTempDir("lumisca-builtin-global-");
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
    await removeDirRetry(root);
    await removeDirRetry(global);
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

Deno.test("the coding-agents skill teaches the discovery flow it needs", async () => {
  // A stella conversation has the task tool, but nothing told its agent when
  // a job is big enough to split — so the skill is advertised there. It must
  // teach the tool_search step, because the tool is not in every session's
  // preloaded set (a sub-agent's own set has no hub of its own).
  const skills = builtinSkills({
    browser: false,
    computer: false,
    stella: true,
    subagents: true,
  });
  const coding = skills.find((skill) => skill.name === "coding-agents");
  assert(coding !== undefined, "the coding-agents skill must be advertised");
  assert(
    coding.description.includes("sub-agent"),
    coding.description,
  );

  const read = coding.read;
  assert(read !== undefined, "the skill must be readable");
  const body = await read(undefined);
  // The flow the request named: read the skill → find the tool → call it.
  assert(body.includes("tool_search"), "teaches tool_search");
  assert(body.includes("tool_call"), "teaches tool_call");
  assert(body.includes(`"task"`), "names the task tool");
  // Several at once is a rule, not an accident: the skill has to say so, or
  // an agent splits a job and then runs the parts one after another.
  assert(body.includes("8"), "states how many may run at once");
  assert(body.includes("task_output"), "teaches collecting the reports");
});

Deno.test("a session without a sub-agent hub is not pointed at one", () => {
  const skills = builtinSkills({
    browser: false,
    computer: false,
    stella: false,
    subagents: false,
  });
  assertEquals(skills.some((skill) => skill.name === "coding-agents"), false);
});
