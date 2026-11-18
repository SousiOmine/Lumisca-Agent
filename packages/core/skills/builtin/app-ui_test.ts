import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  appComponentNames,
  parseAppSpec,
  UI_HELP,
} from "../../shared/ui-app/index.ts";
import { subagentSkills } from "../../tools/tool-pieces.ts";
import { loadSkillContent } from "../discover.ts";
import { appUiSkill } from "./app-ui.ts";

test("app-ui: the guide names every catalog component", async () => {
  const body = await loadSkillContent(appUiSkill());
  for (const name of appComponentNames()) {
    assert(body.includes(`### ${name}`), `the guide omits ${name}`);
  }
  assert(body.includes("$bindState"));
  assert(body.includes("$bindItem"));
  assert(body.includes("sendMessage"));
  assert(body.includes("not saved"));
  assert(UI_HELP.includes("`ui`"));
  assert(UI_HELP.includes("app-ui"));
});

test("app-ui: the guide's example is a valid spec", async () => {
  const body = await loadSkillContent(appUiSkill());
  const start = body.lastIndexOf("```ui\n");
  assert(start >= 0, "the guide has a ui fence");
  const end = body.indexOf("\n```", start + 6);
  assert(end > start, "the guide's example is closed");
  const json = body.slice(start + 6, end);
  const parsed = parseAppSpec(json);
  assertEquals(parsed.ok, true, parsed.ok ? "" : parsed.problem);
});

test("app-ui: a sub-agent is not pointed at the guide", () => {
  assertEquals(subagentSkills([appUiSkill()], {}), []);
});
