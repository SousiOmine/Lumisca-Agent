import { assert, assertEquals } from "@std/assert";
import {
  buildChatSystemPrompt,
  buildSystemPrompt,
  sessionSkills,
} from "./mod.ts";
import type { Workspace } from "../types/workspace.ts";

/** A folder-less workspace for prompt tests: no project memory, no
 * workspace skills — the skill set is global + built-in skills only. */
const workspace: Workspace = {
  id: "ws_test",
  name: "test",
  folders: [],
  createdAt: 0,
  chat: false,
};

// --- sessionSkills gating ----------------------------------------------------

Deno.test("sessionSkills advertises the web-browser skill only with a browser backend", () => {
  const withBrowser = sessionSkills([], { browserAvailable: true });
  assert(
    withBrowser.some((s) => s.name === "web-browser"),
    "web-browser must be advertised when the browser backend is attached",
  );
  for (
    const opts of [
      undefined,
      {},
      { browserAvailable: false },
    ]
  ) {
    const without = sessionSkills([], opts as { browserAvailable?: boolean });
    assertEquals(
      without.some((s) => s.name === "web-browser"),
      false,
      `web-browser must not be advertised for ${JSON.stringify(opts)}`,
    );
  }
});

// --- prompt listing ----------------------------------------------------------

Deno.test("coding prompt lists the web-browser skill only with a browser backend", () => {
  const withBrowser = buildSystemPrompt(
    workspace,
    undefined,
    undefined,
    false,
    true,
  );
  assert(withBrowser.includes("<available_skills>"));
  assert(withBrowser.includes("- web-browser:"));
  const without = buildSystemPrompt(workspace);
  assert(!without.includes("web-browser"));
});

Deno.test("chat prompt lists the web-browser skill only with a browser backend", () => {
  const withBrowser = buildChatSystemPrompt(undefined, undefined, false, true);
  assert(withBrowser.includes("<available_skills>"));
  assert(withBrowser.includes("- web-browser:"));
  const without = buildChatSystemPrompt();
  assert(!without.includes("web-browser"));
});

Deno.test("built-in skills are listed after user skills in the coding prompt", () => {
  const prompt = buildSystemPrompt(
    workspace,
    undefined,
    undefined,
    false,
    true,
  );
  // The built-in line uses the built-in description, one line per skill.
  assert(
    prompt.includes(
      "- web-browser: Usage of the built-in web browser (WebView)",
    ),
  );
});
