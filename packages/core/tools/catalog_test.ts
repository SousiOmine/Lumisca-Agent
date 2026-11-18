import { assertEquals, assertRejects } from "@std/assert";
import { ToolCatalog } from "./catalog.ts";
import { ToolRegistry } from "./registry.ts";
import {
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "./schema.ts";

/** A tool that answers its own name, so a call's route is observable. */
function fakeTool(
  name: string,
  options: {
    label?: string;
    description?: string;
    result?: string;
    throw?: string;
  } = {},
): Tool {
  return {
    name,
    label: options.label ?? name,
    description: options.description ?? `${name} tool`,
    parameters: object({ value: optional(string()) }),
    async execute(): Promise<ToolResult> {
      if (options.throw !== undefined) throw new Error(options.throw);
      return {
        content: [{ type: "text", text: options.result ?? `${name} result` }],
        details: {},
      };
    },
  };
}

function textOf(result: ToolResult): string {
  const block = result.content[0]!;
  return block.type === "text" ? block.text : "";
}

Deno.test("catalog: the preloaded set and the registry are one list", () => {
  const registry = new ToolRegistry();
  registry.setTools([fakeTool("mcp__db__query", { label: "db: query" })]);
  const catalog = new ToolCatalog({
    tools: () => [fakeTool("read"), fakeTool("bash")],
    registry: () => registry,
  });
  assertEquals(
    catalog.list().map((tool) => tool.name),
    ["read", "bash", "mcp__db__query"],
  );
  assertEquals(catalog.get("mcp__db__query")?.label, "db: query");
});

Deno.test("catalog: a name in both sets is the preloaded definition", () => {
  const registry = new ToolRegistry();
  registry.setTools([fakeTool("read", { description: "from the registry" })]);
  const catalog = new ToolCatalog({
    tools: () => [fakeTool("read", { description: "from the agent" })],
    registry: () => registry,
  });
  assertEquals(catalog.list().length, 1);
  assertEquals(catalog.get("read")?.description, "from the agent");
});

Deno.test("catalog: excluded names are never offered", () => {
  const registry = new ToolRegistry();
  registry.setTools([fakeTool("tool_call"), fakeTool("mcp__db__query")]);
  const catalog = new ToolCatalog({
    tools: () => [fakeTool("execute"), fakeTool("read")],
    registry: () => registry,
    exclude: ["execute", "tool_call"],
  });
  assertEquals(
    catalog.list().map((tool) => tool.name),
    ["read", "mcp__db__query"],
  );
});

Deno.test("catalog: search and browse cover both sets", () => {
  const registry = new ToolRegistry();
  registry.setTools([
    fakeTool("mcp__db__query", { label: "db: query", description: "SQL" }),
  ]);
  const catalog = new ToolCatalog({
    tools: () => [fakeTool("read", { description: "Reads a file" })],
    registry: () => registry,
  });
  assertEquals(
    catalog.search("sql", 5).map((entry) => entry.name),
    ["mcp__db__query"],
  );
  const listing = catalog.browse();
  assertEquals(listing.includes("read"), true, listing);
  assertEquals(listing.includes("mcp__db__query"), true, listing);
});

Deno.test("catalog: call runs a tool from either set", async () => {
  const registry = new ToolRegistry();
  registry.setTools([fakeTool("mcp__db__query", { result: "rows" })]);
  const catalog = new ToolCatalog({
    tools: () => [fakeTool("read", { result: "file" })],
    registry: () => registry,
  });
  assertEquals(textOf(await catalog.call("1", "read", {})), "file");
  assertEquals(textOf(await catalog.call("2", "mcp__db__query", {})), "rows");
});

Deno.test("catalog: an unknown name says how to look it up", async () => {
  const catalog = new ToolCatalog({
    tools: () => [],
    registry: () => new ToolRegistry(),
  });
  await assertRejects(
    () => catalog.call("1", "nope", {}),
    Error,
    'Unknown tool "nope". Use tools.tool_search',
  );
});

Deno.test("catalog: a failing tool rejects with its message", async () => {
  const catalog = new ToolCatalog({
    tools: () => [fakeTool("bash", { throw: "command failed" })],
    registry: () => new ToolRegistry(),
  });
  await assertRejects(
    () => catalog.call("1", "bash", {}),
    Error,
    "command failed",
  );
});
