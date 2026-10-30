import { assert, assertEquals } from "@std/assert";
import { SessionToolRegistries } from "./registries.ts";
import { createToolCallTool } from "./call-tool.ts";
import { createToolSearchTool } from "./search-tool.ts";
import { object, type Tool, type ToolContentBlock } from "./schema.ts";

/** The text of a tool result (the search tools answer in text only). */
function textOf(content: readonly ToolContentBlock[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } =>
      block.type === "text"
    )
    .map((block) => block.text)
    .join("");
}

function fakeTool(name: string): Tool {
  return {
    name,
    label: `server: ${name}`,
    description: `Does ${name}`,
    parameters: object({}, {}),
    execute: () =>
      Promise.resolve({ content: [{ type: "text", text: name }], details: {} }),
  };
}

Deno.test("shared tools reach both registries; main-only tools reach one", () => {
  const registries = new SessionToolRegistries();
  registries.addShared([fakeTool("mcp__a__x")]);
  registries.addMainOnly([fakeTool("identity"), fakeTool("agent_create")]);

  // What describes where the session works is every agent's to use.
  assert(registries.main.get("mcp__a__x") !== undefined);
  assert(registries.subagent.get("mcp__a__x") !== undefined);
  // What belongs to this conversation's own agent is not.
  assert(registries.main.get("identity") !== undefined);
  assert(registries.subagent.get("identity") === undefined);
  assert(registries.main.get("agent_create") !== undefined);
  assert(registries.subagent.get("agent_create") === undefined);
});

Deno.test("removing a shared tool removes it from both", () => {
  const registries = new SessionToolRegistries();
  registries.addShared([fakeTool("browser_open"), fakeTool("mcp__a__x")]);
  registries.removeShared(["browser_open"]);

  assertEquals(registries.main.get("browser_open"), undefined);
  assertEquals(registries.subagent.get("browser_open"), undefined);
  // The other shared tool is untouched, on both sides.
  assert(registries.main.get("mcp__a__x") !== undefined);
  assert(registries.subagent.get("mcp__a__x") !== undefined);
});

Deno.test("the sub-agent's tool_search cannot find a main-only tool", async () => {
  const registries = new SessionToolRegistries();
  registries.addShared([fakeTool("mcp__a__x")]);
  registries.addMainOnly([fakeTool("identity"), fakeTool("agent_create")]);

  const mainSearch = createToolSearchTool(() => registries.main);
  const subSearch = createToolSearchTool(() => registries.subagent);

  const mainResult = await mainSearch.execute(
    "t",
    { query: "", limit: 10 },
    undefined,
  );
  const mainText = textOf(mainResult.content);
  assert(mainText.includes("identity"), mainText);
  assert(mainText.includes("agent_create"), mainText);

  const subResult = await subSearch.execute(
    "t",
    { query: "", limit: 10 },
    undefined,
  );
  const subText = textOf(subResult.content);
  assert(subText.includes("mcp__a__x"), subText);
  assertEquals(subText.includes("identity"), false, subText);
  assertEquals(subText.includes("agent_create"), false, subText);

  // The pair is the only way in, so tool_call refuses the same name: a
  // sub-agent cannot reach the tool by guessing it.
  const subCall = createToolCallTool(() => registries.subagent);
  let failed = false;
  try {
    await subCall.execute("t", { name: "identity", args: {} }, undefined);
  } catch {
    failed = true;
  }
  assertEquals(failed, true);
});
