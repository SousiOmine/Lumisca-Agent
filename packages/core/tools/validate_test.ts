import { assertEquals, assertThrows } from "@std/assert";
import { CoreError } from "../errors.ts";
import { toAgentTool } from "./pi-adapter.ts";
import { ToolRegistry } from "./registry.ts";
import { integer, object, optional, string, type Tool } from "./schema.ts";
import { assertSchemaBounds } from "./validate.ts";

/** The `bash` schema as the model was told it, and the argument shapes it
 * actually sent (see the regression note in the required-argument test). */
const bashSchema = object({
  cwd: string("Working directory"),
  command: string("The shell command to execute"),
  timeout: optional(integer("Timeout", { min: 1, max: 3600 })),
});

function errorMessage(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

Deno.test("a required argument that was not sent is reported by name", () => {
  // The regression this guards: a model omits `cwd` (one call in twenty in a
  // recorded session), the value reached path resolution as `undefined`, and
  // the tool returned "Path must be a non-empty string" — a message that
  // names neither the argument nor the tool. The omission is caught here now,
  // where the schema already declares it.
  assertEquals(
    errorMessage(() => assertSchemaBounds(bashSchema, { command: "ls" })),
    "Missing required argument: cwd. Send it and call again.",
  );
  assertEquals(
    errorMessage(() =>
      assertSchemaBounds(bashSchema, { command: "ls", timeout: 30 }),
    ),
    "Missing required argument: cwd. Send it and call again.",
  );
});

Deno.test("a null required argument counts as missing", () => {
  // `null` is what a model sends for a field it decided not to fill; it is
  // not a usable path and does not mean "absent" to the tool either.
  assertEquals(
    errorMessage(() =>
      assertSchemaBounds(bashSchema, { cwd: null, command: "ls" }),
    ),
    "Missing required argument: cwd. Send it and call again.",
  );
});

Deno.test("a complete argument object passes", () => {
  assertSchemaBounds(bashSchema, { cwd: "Aaa", command: "ls" });
  // An optional argument may be absent, which is what `optional()` declares.
  assertSchemaBounds(bashSchema, { cwd: "Aaa", command: "ls", timeout: 60 });
});

Deno.test("the omission is an invalid error, not a crash", () => {
  assertThrows(
    () => assertSchemaBounds(bashSchema, { command: "ls" }),
    CoreError,
    "Missing required argument: cwd. Send it and call again.",
  );
});

Deno.test("empty strings are the tool's business, not the boundary's", () => {
  // `""` was sent on purpose (or by a model that means it), so the tool's own
  // contract reports it — `cwd: ""` reaches path resolution, which explains
  // what a working directory must be. Widening this check to "" would move
  // that explanation behind a generic message.
  assertSchemaBounds(bashSchema, { cwd: "", command: "ls" });
});

Deno.test("declared integer bounds still hold", () => {
  assertEquals(
    errorMessage(() =>
      assertSchemaBounds(bashSchema, {
        cwd: "Aaa",
        command: "ls",
        timeout: 0,
      }),
    ),
    "timeout must be an integer between 1 and 3600 (got 0)",
  );
});

Deno.test("non-object arguments are left to the tool", () => {
  // A provider may hand over anything; the schema's shape is the tool's own
  // contract to enforce (each tool reads its arguments defensively), and the
  // boundary only checks what it can read.
  assertSchemaBounds(bashSchema, null);
  assertSchemaBounds(bashSchema, "not an object");
  assertSchemaBounds(bashSchema, []);
});

function bashLikeTool(seen: unknown[]): Tool<typeof bashSchema> {
  return {
    name: "bash",
    label: "Bash",
    description: "Runs a command",
    parameters: bashSchema,
    execute: (_id, params) => {
      seen.push(params);
      return Promise.resolve({
        content: [{ type: "text", text: "ok" }],
        details: {},
      });
    },
  };
}

Deno.test("the preloaded path rejects an omitted argument before execute", () => {
  // toAgentTool is the boundary every preloaded tool call passes through.
  const seen: unknown[] = [];
  const agentTool = toAgentTool(bashLikeTool(seen));
  assertThrows(
    () => agentTool.execute("call-1", { command: "ls" }, undefined),
    CoreError,
    "Missing required argument: cwd. Send it and call again.",
  );
  assertEquals(seen.length, 0, "execute must not run with a missing argument");
});

Deno.test("the discoverable path rejects an omitted argument before execute", async () => {
  // tool_call reaches a tool through the registry instead, so the same check
  // has to hold there (it applies the tool's prepareArguments first).
  const seen: unknown[] = [];
  const registry = new ToolRegistry();
  registry.setTools([bashLikeTool(seen)]);
  let message = "";
  try {
    await registry.call("call-1", "bash", { command: "ls" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(
    message,
    "Missing required argument: cwd. Send it and call again.",
  );
  assertEquals(seen.length, 0, "execute must not run with a missing argument");
});
