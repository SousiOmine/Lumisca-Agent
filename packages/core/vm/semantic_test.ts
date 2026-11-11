import { assert, assertEquals } from "@std/assert";
import { CoreError } from "../errors.ts";
import type { Tool } from "../tools/schema.ts";
import type { VmExec, VmExecOptions } from "./container.ts";
import { createVmSemanticTools } from "./semantic.ts";

/**
 * The semantic tools are a slim layer: they build one helper request, run it
 * through the machine's exec seam, and turn the JSON answer into a result
 * sentence. What is worth pinning is exactly that translation — which request
 * reaches the helper, and what the agent reads back — because the helper
 * itself runs in the machine and is tested by using it.
 */

/** An exec seam that answers with a scripted helper response. */
function helper(
  answer: unknown,
  options: { exitCode?: number; stderr?: string } = {},
): { run: VmExec; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: (command: readonly string[], _options: VmExecOptions) => {
      calls.push(command.join(" "));
      return Promise.resolve({
        exitCode: options.exitCode ?? 0,
        stdout: typeof answer === "string" ? answer : JSON.stringify(answer),
        stderr: options.stderr ?? "",
        truncated: false,
        timedOut: false,
      });
    },
  };
}

function toolsFor(
  answer: unknown,
  options: { exitCode?: number; stderr?: string } = {},
) {
  const scripted = helper(answer, options);
  return {
    tools: createVmSemanticTools({ exec: scripted.run }),
    calls: scripted.calls,
  };
}

/** The request the helper received, as an object. */
function requestOf(call: string): Record<string, unknown> {
  const quoted = call.slice(call.indexOf("a11y.py") + "a11y.py".length).trim();
  return JSON.parse(quoted) as Record<string, unknown>;
}

/** Run a tool and return the error message it refused with. */
async function refusal(tool: Tool, args: unknown): Promise<CoreError> {
  try {
    await tool.execute("1", args as never, undefined);
  } catch (error) {
    assert(error instanceof CoreError, String(error));
    return error;
  }
  throw new Error("the tool did not refuse");
}

// --- the three tools exist --------------------------------------------------

Deno.test("vm semantic: the three tools carry the names the prompt keys on", () => {
  const { tools } = toolsFor({});
  assertEquals(
    tools.map((tool) => tool.name),
    ["vm_find", "vm_do", "vm_wait"],
  );
});

// --- vm_find ----------------------------------------------------------------

Deno.test("vm_find asks the helper for the filters it was given", async () => {
  const { tools, calls } = toolsFor({
    snapshot: "s12345",
    complete: true,
    matches: [
      {
        ref: "@s12345:e7",
        role: "push button",
        name: "Save",
        text: "",
        states: ["enabled"],
        actions: ["press", "showContextMenu"],
        bounds: { x: 10, y: 20, width: 60, height: 24 },
      },
    ],
  });
  const find = tools[0]!;
  const result = await find.execute(
    "1",
    { app: "chromium", role: "push button", name: "Save" },
    undefined,
  );
  const request = requestOf(calls[0]!);
  assertEquals(request.command, "find");
  assertEquals(request.app, "chromium");
  assertEquals(request.role, "push button");
  assertEquals(request.name, "Save");
  // Actionable by default: the answer is meant to be acted on.
  assertEquals(request.actionable, true);

  const text = result.content[0];
  assert(text?.type === "text");
  // The ref is the first thing the agent needs, so it leads the line.
  assert(text.text.includes("@s12345:e7 push button"), text.text);
  assert(text.text.includes('"Save"'), text.text);
  // `showContextMenu` is on nearly every web node; reporting it would bury
  // the action that matters.
  assert(text.text.includes("actions: press"), text.text);
  assert(!text.text.includes("showContextMenu"), text.text);
});

Deno.test("vm_find reads a window without filters when asked to", async () => {
  const { tools, calls } = toolsFor({ snapshot: "s1", matches: [] });
  const find = tools[0]!;
  // `actionable: "no"` is how a caller asks for static text as well.
  await refusal(find, { app: "chromium", actionable: "no" });
  const request = requestOf(calls[0]!);
  assertEquals(request.actionable, false);
});

Deno.test("vm_find reports the roles a window does have when nothing matches", async () => {
  // A mistyped role and an empty window read the same unless the miss says
  // what IS there.
  const { tools } = toolsFor({
    snapshot: "s1",
    matches: [],
    roles_present: ["push button", "entry", "label"],
  });
  const find = tools[0]!;
  const error = await refusal(find, {
    app: "chromium",
    role: "textbox",
    name: "Email",
  });
  assertEquals(error.kind, "not_found");
  assert(error.message.includes("textbox"), error.message);
  assert(error.message.includes("Roles present"), error.message);
  assert(error.message.includes("entry"), error.message);
});

Deno.test("vm_find marks a truncated walk instead of implying it saw everything", async () => {
  const { tools } = toolsFor({
    snapshot: "s1",
    complete: false,
    matches: [
      {
        ref: "@s1:e2",
        role: "entry",
        name: "Name",
        text: "",
        states: ["enabled"],
        actions: [],
        bounds: null,
      },
    ],
  });
  const find = tools[0]!;
  const result = await find.execute("1", { app: "chromium" }, undefined);
  const text = result.content[0];
  assert(text?.type === "text");
  assert(text.text.includes("larger than the walk budget"), text.text);
});

Deno.test("vm_find spells out a disabled control", async () => {
  const { tools } = toolsFor({
    snapshot: "s1",
    matches: [
      {
        ref: "@s1:e9",
        role: "push button",
        name: "Submit",
        text: "",
        states: ["focused"],
        actions: ["press"],
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      },
    ],
  });
  const find = tools[0]!;
  const result = await find.execute("1", { app: "chromium" }, undefined);
  const text = result.content[0];
  assert(text?.type === "text");
  // `enabled` absent is how this bus reports a disabled control; a click on a
  // greyed-out button must not look like a tool bug.
  assert(text.text.includes("[disabled, focused]"), text.text);
});

// --- vm_do ------------------------------------------------------------------

Deno.test("vm_do sends the action and reports what was read back", async () => {
  const { tools, calls } = toolsFor({
    ok: true,
    delivery: "delivered_verified",
    after: { name: "Saved", text: "", states: ["enabled"] },
  });
  const action = tools[1]!;
  const result = await action.execute(
    "1",
    { ref: "@s1:e4", action: "click" },
    undefined,
  );
  const request = requestOf(calls[0]!);
  assertEquals(request.command, "do");
  assertEquals(request.ref, "@s1:e4");
  assertEquals(request.action, "click");

  const text = result.content[0];
  assert(text?.type === "text");
  assert(text.text.includes("delivered_verified"), text.text);
  assert(!text.text.includes("may act twice"), text.text);
});

Deno.test("vm_do warns before an unverified action is repeated", async () => {
  // `delivered_unverified` means the app accepted the action but nothing
  // readable changed. Repeating a click is how a form submits twice.
  const { tools } = toolsFor({
    ok: true,
    delivery: "delivered_unverified",
    after: {},
  });
  const action = tools[1]!;
  const result = await action.execute(
    "1",
    { ref: "@s1:e4", action: "click" },
    undefined,
  );
  const text = result.content[0];
  assert(text?.type === "text");
  assert(text.text.includes("delivered_unverified"), text.text);
  assert(text.text.includes("may act twice"), text.text);
});

Deno.test("vm_do passes set_value, select and key through", async () => {
  const { tools, calls } = toolsFor({
    ok: true,
    delivery: "delivered_verified",
  });
  const action = tools[1]!;
  await action.execute(
    "1",
    { ref: "@s1:e1", action: "set_value", value: "a@example.com" },
    undefined,
  );
  await action.execute(
    "1",
    { ref: "@s1:e2", action: "select", value: "Blue" },
    undefined,
  );
  await action.execute(
    "1",
    { ref: "@s1:e3", action: "key", key: "ctrl+a" },
    undefined,
  );
  const requests = calls.map(requestOf);
  assertEquals(requests[0]!.value, "a@example.com");
  assertEquals(requests[1]!.value, "Blue");
  assertEquals(requests[2]!.key, "ctrl+a");
});

Deno.test("vm_do refuses a missing argument before calling the machine", async () => {
  const { tools, calls } = toolsFor({ ok: true });
  const action = tools[1]!;
  const value = await refusal(action, { ref: "@s1:e1", action: "set_value" });
  assert(value.message.includes("text to write"), value.message);
  const select = await refusal(action, { ref: "@s1:e1", action: "select" });
  assert(select.message.includes("option's name"), select.message);
  const key = await refusal(action, { ref: "@s1:e1", action: "key" });
  assert(key.message.includes("key name"), key.message);
  const scroll = await refusal(action, { ref: "@s1:e1", action: "scroll" });
  assert(scroll.message.includes("vertical or horizontal"), scroll.message);
  const unknown = await refusal(action, { ref: "@s1:e1", action: "teleport" });
  assert(unknown.message.includes("one of"), unknown.message);
  // None of those reached the machine.
  assertEquals(calls.length, 0);
});

Deno.test("vm_do says when a check found the box already set", async () => {
  const { tools } = toolsFor({
    ok: true,
    unchanged: true,
    states: ["checked"],
  });
  const action = tools[1]!;
  const result = await action.execute(
    "1",
    { ref: "@s1:e6", action: "check" },
    undefined,
  );
  const text = result.content[0];
  assert(text?.type === "text");
  assert(text.text.includes("already"), text.text);
});

// --- vm_wait ----------------------------------------------------------------

Deno.test("vm_wait passes a plain delay through", async () => {
  const { tools, calls } = toolsFor({ ok: true, waited_ms: 500 });
  const wait = tools[2]!;
  const result = await wait.execute("1", { ms: 500 }, undefined);
  const request = requestOf(calls[0]!);
  assertEquals(request.ms, 500);
  const text = result.content[0];
  assert(text?.type === "text");
  assert(text.text.includes("500"), text.text);
});

Deno.test("vm_wait turns the filters into a condition", async () => {
  const { tools, calls } = toolsFor({
    ok: true,
    present: true,
    waited_ms: 120,
  });
  const wait = tools[2]!;
  const result = await wait.execute(
    "1",
    { app: "chromium", text: "Thank you", timeout_ms: 3000 },
    undefined,
  );
  const request = requestOf(calls[0]!);
  assertEquals(request.app, "chromium");
  assertEquals(request.text, "Thank you");
  assertEquals(request.timeout_ms, 3000);
  // `gone` defaults to waiting for presence.
  assertEquals(request.gone, undefined);
  const text = result.content[0];
  assert(text?.type === "text");
  assert(text.text.includes("present"), text.text);
});

Deno.test("vm_wait supports waiting for something to disappear", async () => {
  const { tools, calls } = toolsFor({
    ok: true,
    present: false,
    waited_ms: 40,
  });
  const wait = tools[2]!;
  await wait.execute(
    "1",
    { app: "chromium", role: "push button", name: "Cancel", gone: "yes" },
    undefined,
  );
  assertEquals(requestOf(calls[0]!).gone, true);
});

Deno.test("vm_wait refuses an app with no condition and a condition with no app", async () => {
  const { tools, calls } = toolsFor({ ok: true });
  const wait = tools[2]!;
  const noCondition = await refusal(wait, { app: "chromium" });
  assert(
    noCondition.message.includes("role, name or text"),
    noCondition.message,
  );
  const noApp = await refusal(wait, { name: "Save" });
  assert(noApp.message.includes("ms"), noApp.message);
  assertEquals(calls.length, 0);
});

// --- the helper's own failures ----------------------------------------------

Deno.test("a helper error reaches the agent as the sentence it wrote", async () => {
  // The helper's messages name what happened inside the machine ("the element
  // is gone"), which is what the agent bases its next move on.
  const { tools } = toolsFor({
    error: "the element @s1:e4 is gone: the window changed. Run find again.",
  });
  const action = tools[1]!;
  const error = await refusal(action, { ref: "@s1:e4", action: "click" });
  assertEquals(error.kind, "invalid");
  assert(error.message.includes("the element @s1:e4 is gone"), error.message);
});

Deno.test("a helper that never ran is reported as the machine's problem", async () => {
  // Empty stdout means the helper did not get as far as writing its own
  // answer: a missing interpreter or package, not a missing element.
  const { tools } = toolsFor("", {
    exitCode: 1,
    stderr: "python3: can't open file '/usr/local/lib/lumisca/a11y.py'",
  });
  const find = tools[0]!;
  const error = await refusal(find, { app: "chromium" });
  assertEquals(error.kind, "unavailable");
  assert(error.message.includes("helper could not run"), error.message);
  assert(error.message.includes("a11y.py"), error.message);
});

Deno.test("a helper that answers non-JSON is reported, not parsed loosely", async () => {
  const { tools } = toolsFor("Traceback (most recent call last): ...");
  const find = tools[0]!;
  const error = await refusal(find, { app: "chromium" });
  assertEquals(error.kind, "unavailable");
  assert(error.message.includes("not"), error.message);
});
