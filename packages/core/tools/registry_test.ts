import { assert, assertEquals, assertRejects } from "@std/assert";
import { TOOL_CALL, TOOL_SEARCH } from "../shared.ts";
import { createToolCallTool } from "./call-tool.ts";
import { MAX_SEARCH_DESCRIPTION_CHARS, ToolRegistry } from "./registry.ts";
import { createToolSearchTool } from "./search-tool.ts";
import { object, string, type Tool, type ToolContentBlock } from "./schema.ts";

function fakeTool(
  name: string,
  options: {
    label?: string;
    description?: string;
    argNames?: string[];
    result?: string;
  } = {},
): Tool {
  const properties: Record<string, ReturnType<typeof string>> = {};
  for (const key of options.argNames ?? []) properties[key] = string();
  return {
    name,
    label: options.label ?? `server: ${name}`,
    description: options.description ?? `Does ${name}`,
    parameters: object(properties, {}),
    execute: (_id, params) =>
      Promise.resolve({
        content: [{
          type: "text",
          text: options.result ??
            `result of ${name}: ${JSON.stringify(params)}`,
        }],
        details: {},
      }),
  };
}

function searchResult(
  registry: ToolRegistry,
  query: string,
  limit = 10,
): string[] {
  return registry.search(query, limit).map((entry) => entry.name);
}

// --- search ranking ---------------------------------------------------------

Deno.test("search ranks exact name matches above partial and description matches", () => {
  const registry = new ToolRegistry();
  registry.setTools([
    fakeTool("db_query", { description: "run sql against the database" }),
    fakeTool("db_connect", { description: "open a database connection" }),
    fakeTool("fs_read", { description: "read files" }),
    fakeTool("other", {
      description: "database utilities for the data team",
    }),
  ]);

  // Exact name wins over a description-only match.
  assertEquals(searchResult(registry, "db_query"), ["db_query"]);
  // Partial name beats description text; ties break alphabetically.
  assertEquals(
    searchResult(registry, "db"),
    ["db_connect", "db_query"],
  );
  // Description-only matches still surface, ranked below name matches.
  const database = searchResult(registry, "database");
  assert(database.includes("db_query"));
  assert(database.includes("other"));
  // Empty query matches nothing (browse is the listing path).
  assertEquals(searchResult(registry, ""), []);
});

Deno.test("search is case-insensitive and matches the server label", () => {
  const registry = new ToolRegistry();
  registry.setTools([
    fakeTool("query", { label: "postgres: query" }),
    fakeTool("connect", { label: "mysql: connect" }),
  ]);
  assertEquals(searchResult(registry, "POSTGRES"), ["query"]);
  assertEquals(searchResult(registry, "mysql"), ["connect"]);
});

Deno.test("search respects the limit", () => {
  const registry = new ToolRegistry();
  registry.setTools([
    fakeTool("a", { description: "alpha" }),
    fakeTool("b", { description: "alpha" }),
    fakeTool("c", { description: "alpha" }),
  ]);
  assertEquals(searchResult(registry, "alpha", 2).length, 2);
});

// --- describe ---------------------------------------------------------------

Deno.test("describe reports name, label, truncated description and argument names", () => {
  const registry = new ToolRegistry();
  registry.setTools([
    fakeTool("echo", {
      label: "fake: echo",
      description: `d`.repeat(MAX_SEARCH_DESCRIPTION_CHARS + 500),
      argNames: ["text"],
    }),
  ]);
  const entry = registry.search("echo", 1)[0]!;
  assertEquals(entry.name, "echo");
  assertEquals(entry.label, "fake: echo");
  assertEquals(entry.argNames, ["text"]);
  assert(
    entry.description.length < `d`.repeat(MAX_SEARCH_DESCRIPTION_CHARS + 500)
      .length,
    "description must be truncated",
  );
  assert(entry.description.endsWith("(truncated)"));
});

Deno.test("describe reports no argument names for permissive schemas", () => {
  const registry = new ToolRegistry();
  registry.setTools([
    {
      name: "permissive",
      label: "server: permissive",
      description: "arbitrary args",
      parameters: object({}, { additionalProperties: true }),
      execute: () =>
        Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          details: {},
        }),
    },
  ]);
  assertEquals(registry.search("permissive", 1)[0]!.argNames, []);
});

// --- browse -----------------------------------------------------------------

Deno.test("browse groups tools by label prefix and caps the listing", () => {
  const registry = new ToolRegistry();
  registry.setTools([
    fakeTool("mcp__db__query", { label: "db: query" }),
    fakeTool("mcp__db__connect", { label: "db: connect" }),
    fakeTool("mcp__fs__read", { label: "fs: read" }),
  ]);
  const text = registry.browse();
  assert(text.includes("3 tools available"));
  assert(text.includes("db (2): mcp__db__connect, mcp__db__query"));
  assert(text.includes("fs (1): mcp__fs__read"));
});

// --- registration -----------------------------------------------------------

Deno.test("setTools replaces and addTools merges idempotently", () => {
  const registry = new ToolRegistry();
  const a = fakeTool("a");
  const b = fakeTool("b");
  registry.addTools([a, a, b]);
  assertEquals(registry.count, 2);
  registry.setTools([fakeTool("c")]);
  assertEquals(registry.count, 1);
  assertEquals(registry.get("a"), undefined);
  assertEquals(registry.get("c")?.name, "c");
  assert(!registry.isEmpty);
});

// --- call -------------------------------------------------------------------

/** First text block of a tool result (test tools are text-only). */
function textOf(result: { content: ToolContentBlock[] }): string {
  const block = result.content[0]!;
  return block.type === "text" ? block.text : "";
}

Deno.test("call dispatches to the tool's execute with prepared arguments", async () => {
  const calls: unknown[] = [];
  const registry = new ToolRegistry();
  const sumSchema = object({ a: string(), b: string() }, {});
  const sumTool: Tool<typeof sumSchema> = {
    name: "sum",
    label: "math: sum",
    description: "adds numbers",
    parameters: sumSchema,
    prepareArguments: (args) => ({
      a: String((args as { a: unknown }).a),
      b: String((args as { b: unknown }).b),
    }),
    execute: (_id, params) => {
      calls.push(params);
      return Promise.resolve({
        content: [{ type: "text", text: `sum=${params.a}+${params.b}` }],
        details: {},
      });
    },
  };
  registry.setTools([sumTool]);
  const result = await registry.call("call-1", "sum", { a: 1, b: 2 });
  assertEquals(textOf(result), "sum=1+2");
  assertEquals(calls, [{ a: "1", b: "2" }]);
});

Deno.test("call rejects unknown tools", async () => {
  const registry = new ToolRegistry();
  await assertRejects(
    () => registry.call("call-1", "nope", {}),
    Error,
    "Unknown tool nope. Use tool_search to find available tools.",
  );
});

// --- the search / call tools ------------------------------------------------

Deno.test("tool_search returns matches with usage instructions", async () => {
  const registry = new ToolRegistry();
  registry.setTools([
    fakeTool("mcp__db__query", {
      label: "db: query",
      description: "Runs SQL",
      argNames: ["sql"],
    }),
  ]);
  const tool = createToolSearchTool(() => registry);
  const result = await tool.execute("call-1", { query: "sql" });
  const text = textOf(result);
  assert(text.includes('Found 1 tool(s) matching "sql"'));
  assert(text.includes("mcp__db__query"));
  assert(text.includes("Arguments: sql"));
  assert(text.includes("Call one with tool_call(name, args)."));
});

Deno.test("tool_search with an empty query browses instead of searching", async () => {
  const registry = new ToolRegistry();
  registry.setTools([fakeTool("mcp__db__query", { label: "db: query" })]);
  const tool = createToolSearchTool(() => registry);
  const result = await tool.execute("call-1", {});
  const text = textOf(result);
  assert(text.includes("1 tools available"), text);
  assert(text.includes("mcp__db__query"));
  assert(!text.includes("Call one with tool_call"));
});

Deno.test("tool_search reports no matches with the browse listing", async () => {
  const registry = new ToolRegistry();
  registry.setTools([fakeTool("mcp__db__query", { label: "db: query" })]);
  const tool = createToolSearchTool(() => registry);
  const result = await tool.execute("call-1", { query: "zzz" });
  assert(textOf(result).includes('No tools match "zzz"'));
  assert(textOf(result).includes("mcp__db__query"));
});

Deno.test("tool_call executes the named tool and prefixes its name", async () => {
  const registry = new ToolRegistry();
  registry.setTools([
    fakeTool("mcp__db__query", {
      result: "rows",
    }),
  ]);
  const tool = createToolCallTool(() => registry);
  const result = await tool.execute("call-1", {
    name: "mcp__db__query",
    args: { sql: "SELECT 1" },
  });
  assertEquals(textOf(result), "[mcp__db__query]\nrows");
  assertEquals(result.details.tool, "mcp__db__query");
});

Deno.test("tool_call rejects unknown names with a search hint", async () => {
  const registry = new ToolRegistry();
  const tool = createToolCallTool(() => registry);
  await assertRejects(
    () => tool.execute("call-1", { name: "nope", args: {} }),
    Error,
    "Unknown tool nope. Use tool_search to find available tools.",
  );
});

Deno.test("the search/call pair resolves the registry through the provider", async () => {
  const first = new ToolRegistry();
  first.setTools([fakeTool("mcp__old__ping")]);
  const second = new ToolRegistry();
  second.setTools([fakeTool("mcp__new__ping")]);
  let current: ToolRegistry = first;
  const search = createToolSearchTool(() => current);
  const call = createToolCallTool(() => current);

  const before = await search.execute("call-1", { query: "ping" });
  assert(textOf(before).includes("mcp__old__ping"));
  assert(!textOf(before).includes("mcp__new__ping"));

  // A config change swaps the registry behind the pair — what happens to a
  // running sub-agent when the session pool rebuilds the session's
  // registry. The pair redirects without being replaced.
  current = second;
  const after = await search.execute("call-2", { query: "ping" });
  assert(textOf(after).includes("mcp__new__ping"));
  assert(!textOf(after).includes("mcp__old__ping"));
  await assertRejects(
    () => call.execute("call-3", { name: "mcp__old__ping" }),
    Error,
    "Unknown tool mcp__old__ping",
  );
});

Deno.test("tool names are the shared constants", () => {
  assertEquals(
    createToolSearchTool(() => new ToolRegistry()).name,
    TOOL_SEARCH,
  );
  assertEquals(createToolCallTool(() => new ToolRegistry()).name, TOOL_CALL);
});
