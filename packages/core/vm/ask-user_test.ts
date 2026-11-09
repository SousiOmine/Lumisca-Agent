import { assertEquals } from "@std/assert";
import { createVmAskUserTool } from "./ask-user.ts";
import { HandoverHub } from "./handover.ts";

/**
 * `vm_ask_user`'s two outcomes. The hub owns the timing; what matters here
 * is what the MODEL is told: a deadline must read as "the user did not
 * come" (so it chooses another way), never as a finished hand-over.
 */

Deno.test("vm_ask_user: the deadline becomes a result, not a failure", async () => {
  const hub = new HandoverHub("s1", () => {}, 10);
  const tool = createVmAskUserTool({ handover: hub });
  const result = await tool.execute("call-1", { reason: "Needs a password" });
  assertEquals(result.details.timedOut, true);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  // Without this the model reads a timeout as a successful hand-over and
  // clicks at a screen the user may be using.
  assertEquals(text.includes("did not come"), true, text);
  assertEquals(text.includes("do not take the pointer back"), true, text);
});

Deno.test("vm_ask_user: a finished hand-over reports what the user did", async () => {
  const hub = new HandoverHub("s1", () => {}, 60_000);
  const tool = createVmAskUserTool({ handover: hub });
  const pending = tool.execute("call-1", {
    reason: "Needs a password",
    instructions: "Type it and press Enter",
  });
  hub.finish("logged in");
  const result = await pending;
  assertEquals(result.details.note, "logged in");
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assertEquals(text.includes("logged in"), true);
});
