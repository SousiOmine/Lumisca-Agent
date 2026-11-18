import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { createHostCodeRuntime } from "../code-execution/host.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import { toolText } from "../test-utils.ts";
import { ToolCatalog } from "./catalog.ts";
import { createExecuteTool } from "./execute.ts";
import { ToolRegistry } from "./registry.ts";
import {
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "./schema.ts";
import { createToolSearchTool } from "./search-tool.ts";

function fakeTool(
  name: string,
  options: { result?: string; throw?: string; images?: number } = {},
): Tool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: object({ value: optional(string()) }),
    async execute(): Promise<ToolResult> {
      if (options.throw !== undefined) throw new Error(options.throw);
      const content: ToolResult["content"] = [
        { type: "text", text: options.result ?? `${name} result` },
      ];
      for (let index = 0; index < (options.images ?? 0); index++) {
        content.push({
          type: "image",
          data: `image-${index}`,
          mimeType: "image/png",
        });
      }
      return { content, details: {} };
    },
  };
}

function makeCatalog(
  tools: readonly Tool[],
  registryTools: readonly Tool[] = [],
) {
  const registry = new ToolRegistry();
  registry.setTools([...registryTools]);
  const search = createToolSearchTool(() => catalog, "code");
  const catalog = new ToolCatalog({
    tools: () => [...tools, search],
    registry: () => registry,
    exclude: ["execute", "tool_call"],
  });
  return catalog;
}

function makeExecute(options: {
  tools?: readonly Tool[];
  registryTools?: readonly Tool[];
  safety?: CommandSafety;
}) {
  return createExecuteTool({
    catalog: makeCatalog(options.tools ?? [], options.registryTools ?? []),
    runtime: createHostCodeRuntime(),
    cwd: "/tmp",
    ...(options.safety !== undefined ? { safety: options.safety } : {}),
  });
}

test("execute: a program returns its value and its calls' results", async () => {
  const tool = makeExecute({
    tools: [fakeTool("read", { result: "file body" })],
  });
  const result = await tool.execute(
    "call-1",
    {
      code: 'const first = await tools.read({ value: "a" }); return first.toUpperCase();',
    },
    undefined,
  );
  const text = toolText(result);
  // A returned string is reported as itself, so the case change is what
  // proves the value went through the program.
  assert(text.includes("[result]\nFILE BODY"), text);
  assert(text.includes("[calls]\nread ×1"), text);
});

test("execute: a syntax error shows the line and the caret", async () => {
  const tool = makeExecute({});
  const result = await tool.execute(
    "call-1",
    { code: "const a = 1;\nconst text = `a ` b`;" },
    undefined,
  );
  const text = toolText(result);
  assert(text.startsWith("[error]"), text);
  assert(text.includes("Syntax error at line 2"), text);
  assert(text.includes("2 | const text = `a ` b`;"), text);
  assert(text.includes("^"), text);
  assert(text.includes("template literal"), text);
});

test("execute: console output is kept and the value inspected", async () => {
  const tool = makeExecute({});
  const result = await tool.execute(
    "call-1",
    { code: 'console.log("working"); return { ok: true, items: [1, 2] };' },
    undefined,
  );
  const text = toolText(result);
  assert(text.includes("[output]\nworking"), text);
  assert(text.includes("{ ok: true, items: [ 1, 2 ] }"), text);
});

test("execute: a failing tool throws inside the program", async () => {
  const tool = makeExecute({
    tools: [fakeTool("bash", { throw: "exit code 1" })],
  });
  const result = await tool.execute(
    "call-1",
    {
      code:
        'try { await tools.bash({}); return "unreachable"; } ' +
        'catch (error) { return "caught: " + error.message; }',
    },
    undefined,
  );
  const text = toolText(result);
  assert(text.includes("caught: exit code 1"), text);
  // The reported duration is the measured one, so a slow runner says 1ms:
  // this checks the shape (one call, marked failed) and not the number.
  assert(/bash ×1 \(\d+ms\) failed/.test(text), text);
});

test("execute: an unknown tool names the way to look it up", async () => {
  const tool = makeExecute({});
  const result = await tool.execute(
    "call-1",
    { code: "await tools.nope({})" },
    undefined,
  );
  const text = toolText(result);
  assert(text.includes("[error]"), text);
  assert(text.includes('Unknown tool "nope"'), text);
  assert(text.includes("tools.tool_search"), text);
});

test("execute: tool_search is part of the catalog, not the agent", async () => {
  const tool = makeExecute({ tools: [fakeTool("read")] });
  const result = await tool.execute(
    "call-1",
    { code: "return await tools.tool_search({});" },
    undefined,
  );
  const text = toolText(result);
  assert(text.includes("read"), text);
  assert(text.includes("tool_search"), text);
});

test("execute: the call cap stops a runaway program", async () => {
  const tool = makeExecute({ tools: [fakeTool("read")] });
  const result = await tool.execute(
    "call-1",
    {
      code: "for (let i = 0; i < 60; i++) { await tools.read({}); } return 'done';",
    },
    undefined,
  );
  const text = toolText(result);
  assert(text.includes("[error]"), text);
  assert(text.includes("50 tool calls"), text);
});

test("execute: at most three images reach the conversation", async () => {
  const tool = makeExecute({
    tools: [fakeTool("screenshot", { images: 2 })],
  });
  const result = await tool.execute(
    "call-1",
    {
      code: "for (let i = 0; i < 3; i++) { await tools.screenshot({}); } return 'ok';",
    },
    undefined,
  );
  const images = result.content.filter((block) => block.type === "image");
  assertEquals(images.length, 3);
});

test("execute: a program that never ends is stopped by the timeout", async () => {
  const tool = makeExecute({});
  const result = await tool.execute(
    "call-1",
    { code: "while (true) {}", timeout: 1000 },
    undefined,
  );
  const text = toolText(result);
  assert(text.includes("[error]"), text);
  assert(text.includes("timed out"), text);
});

test("execute: a blocked program is a result, not a tool failure", async () => {
  const safety: CommandSafety = {
    check: () => Promise.resolve({ ok: false, reason: "destroys data" }),
  } as unknown as CommandSafety;
  const tool = makeExecute({ safety });
  const result = await tool.execute("call-1", { code: "1" }, undefined);
  const text = toolText(result);
  assert(text.includes("[blocked by safety check]"), text);
  assert(text.includes("destroys data"), text);
  assertEquals(result.details["blocked"], true);
});

test("execute: a program may keep state across its own calls only", async () => {
  const tool = makeExecute({});
  await tool.execute("call-1", { code: "var kept = 41;" }, undefined);
  const result = await tool.execute("call-2", { code: "kept + 1" }, undefined);
  assert(toolText(result).includes("[error]"), toolText(result));
});
