import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  array,
  boolean,
  integer,
  object,
  optional,
  string,
  stringMap,
  type Tool,
  type ToolSchema,
} from "../ports/tool.ts";
import { MAX_TOOL_SDK_CHARS, renderToolSdk } from "./sdk.ts";

function tool(name: string, description: string, parameters: ToolSchema): Tool {
  return {
    name,
    label: name,
    description,
    parameters,
    execute: () =>
      Promise.resolve({
        content: [{ type: "text", text: "" }],
        details: {},
      }),
  };
}

test("sdk: declares a tool's arguments and the store globals", () => {
  const sdk = renderToolSdk([
    tool(
      "read",
      "Read a file.",
      object({
        path: string(),
        offset: optional(integer()),
      }),
    ),
  ]);
  assert(sdk.includes("declare const tools"), sdk);
  assert(
    sdk.includes(
      "read(args: { path: string; offset?: number }): Promise<string>;",
    ),
    sdk,
  );
  assert(
    sdk.includes("declare function store(key: string, value: unknown): void;"),
    sdk,
  );
  assert(sdk.includes("declare function load(key: string): unknown;"), sdk);
});

test("sdk: renders nested objects, arrays, maps and open objects", () => {
  const sdk = renderToolSdk([
    tool(
      "write",
      "Write a file.",
      object({
        path: string(),
        tags: array(string()),
        opts: object({ deep: boolean() }),
        env: stringMap(),
      }),
    ),
    tool("open", "Open something.", object({}, { additionalProperties: true })),
  ]);
  assert(sdk.includes("tags: Array<string>"), sdk);
  assert(sdk.includes("opts: { deep: boolean }"), sdk);
  assert(sdk.includes("env: Record<string, string>"), sdk);
  assert(
    sdk.includes("open(args: Record<string, unknown>): Promise<string>;"),
    sdk,
  );
});

test("sdk: quotes a tool name that is not an identifier", () => {
  const sdk = renderToolSdk([
    tool("some-tool", "A tool.", object({ value: string() })),
  ]);
  assert(
    sdk.includes('"some-tool"(args: { value: string }): Promise<string>;'),
    sdk,
  );
});

test("sdk: keeps a description to one line and cannot close the comment", () => {
  const sdk = renderToolSdk([
    tool(
      "read",
      "Read a file.\nIt closes */ here.",
      object({ path: string() }),
    ),
  ]);
  assert(sdk.includes("/** Read a file. It closes *\\/ here. */"), sdk);
  assertEquals(sdk.includes("Read a file.\n"), false);
});

test("sdk: the budget drops descriptions before tool names", () => {
  const tools: Tool[] = [];
  for (let index = 0; index < 40; index++) {
    tools.push(
      tool("tool" + index, "x".repeat(500), object({ value: string() })),
    );
  }
  const sdk = renderToolSdk(tools);
  assert(sdk.length <= MAX_TOOL_SDK_CHARS, String(sdk.length));
  for (const item of tools) assert(sdk.includes(item.name), item.name);
});

test("sdk: the output is sorted by tool name", () => {
  const sdk = renderToolSdk([
    tool("beta", "B.", object({})),
    tool("alpha", "A.", object({})),
  ]);
  assert(sdk.indexOf("alpha") < sdk.indexOf("beta"), sdk);
  assertEquals(
    renderToolSdk([
      tool("beta", "B.", object({})),
      tool("alpha", "A.", object({})),
    ]),
    sdk,
  );
});
