import { assertEquals, assertRejects } from "@std/assert";
import type { ClientEvent } from "../domain/event.ts";
import { createVmEnvTool } from "./env-tool.ts";
import { EnvRequestHub } from "./env-request.ts";
import type { VmEnvStore } from "./env-store.ts";

/**
 * `vm_env` as the model sees it: one argument, a wait, and a sentence that
 * never carries a value.
 */

/** A store that only answers "is this name set?": the tool never reads or
 * writes a value, so nothing else is needed. */
function storeWith(names: string[]): VmEnvStore {
  return {
    has: (name: string) => Promise.resolve(names.includes(name)),
  } as unknown as VmEnvStore;
}

function textOf(result: { content: unknown[] }): string {
  const [first] = result.content as { type: string; text?: string }[];
  return first?.type === "text" ? first.text ?? "" : "";
}

Deno.test("vm env: the only argument is the variable's name", () => {
  const tool = createVmEnvTool({
    requests: new EnvRequestHub("s1", () => {}),
    store: storeWith([]),
  });
  assertEquals(tool.parameters.required, ["name"]);
  // The description is what tool_search shows, so it has to say what the
  // tool is for in the words a search would use.
  assertEquals(tool.description.includes("environment variable"), true);
  assertEquals(tool.description.includes("secret"), true);
});

Deno.test("vm env: asking announces the name and reports that it is set", async () => {
  const events: ClientEvent[] = [];
  const hub = new EnvRequestHub("s1", (event) => events.push(event));
  const tool = createVmEnvTool({ requests: hub, store: storeWith([]) });

  const waited = tool.execute("call-1", { name: "OPENAI_API_KEY" });
  // The request is announced before the tool blocks.
  await Promise.resolve();
  assertEquals(events.length, 1);
  assertEquals(events[0]!.type, "env_request");
  if (events[0]!.type === "env_request") {
    assertEquals(events[0]!.name, "OPENAI_API_KEY");
    assertEquals(events[0]!.exists, false);
  }

  hub.finish("call-1");
  const text = textOf(await waited);
  assertEquals(text.includes("OPENAI_API_KEY"), true);
  // No value can be in this sentence: the hub's finish takes none, and the
  // tool never reads the store's contents.
  assertEquals(text.includes("The value itself is not returned"), true);
});

Deno.test("vm env: an existing name is announced as a replacement", async () => {
  const events: ClientEvent[] = [];
  const hub = new EnvRequestHub("s1", (event) => events.push(event));
  const tool = createVmEnvTool({
    requests: hub,
    store: storeWith(["GITHUB_TOKEN"]),
  });

  const waited = tool.execute("call-1", { name: "GITHUB_TOKEN" });
  await Promise.resolve();
  assertEquals(
    events[0]!.type === "env_request" ? events[0]!.exists : undefined,
    true,
  );
  hub.finish("call-1");
  await waited;
});

Deno.test("vm env: a declined dialog sends the run on without the value", async () => {
  const hub = new EnvRequestHub("s1", () => {});
  const tool = createVmEnvTool({ requests: hub, store: storeWith([]) });
  const waited = tool.execute("call-1", { name: "KEY" });
  await Promise.resolve();
  hub.decline("call-1");
  const text = textOf(await waited);
  assertEquals(text.includes("did not enter a value for KEY"), true);
  // Not an error: the model is told to continue, not to retry.
  assertEquals(text.includes("do not"), true);
});

Deno.test("vm env: a deadline is reported as no value, not as a failure", async () => {
  const hub = new EnvRequestHub("s1", () => {}, 5);
  const tool = createVmEnvTool({ requests: hub, store: storeWith([]) });
  const text = textOf(await tool.execute("call-1", { name: "KEY" }));
  assertEquals(text.includes("did not answer"), true);
  assertEquals(text.includes("KEY is not available"), true);
});

Deno.test("vm env: a name that is not an identifier never opens a dialog", async () => {
  const events: ClientEvent[] = [];
  const hub = new EnvRequestHub("s1", (event) => events.push(event));
  const tool = createVmEnvTool({ requests: hub, store: storeWith([]) });
  await assertRejects(
    () => tool.execute("call-1", { name: "my-key" }),
    Error,
    "shell identifier",
  );
  assertEquals(events.length, 0);
});

Deno.test("vm env: a second dialog while one waits is refused", async () => {
  const hub = new EnvRequestHub("s1", () => {});
  const tool = createVmEnvTool({ requests: hub, store: storeWith([]) });
  const first = tool.execute("call-1", { name: "ONE" });
  await Promise.resolve();
  await assertRejects(
    () => tool.execute("call-2", { name: "TWO" }),
    Error,
    "already being asked",
  );
  hub.finish("call-1");
  await first;
});
