import { assert, assertEquals, assertRejects } from "@std/assert";
import { CoreError } from "../errors.ts";
import type { FolderGrant } from "../share/grant.ts";
import { ShareRequestHub } from "../share/request.ts";
import {
  createShareDisconnectTool,
  createShareRequestTool,
  MAX_SHARE_REASON_CHARS,
} from "./share-request.ts";

/**
 * The two folder tools, without a server: the grants are a list the test
 * mutates, and the request hub is answered the way the routes answer it. What
 * is checked here is the words the model reads — the only thing the model has
 * to go on when a loan does not appear, ends, or is refused.
 */

function grantOf(name: string, write = false): FolderGrant {
  return {
    id: `id-${name}`,
    name,
    sessionId: "s1",
    path: `/home/user/${name}`,
    write,
    expiresAt: Date.now() + 30 * 60_000,
    host: { platform: "linux", name: "pc", shell: "bash" },
  };
}

function text(result: { content: unknown }): string {
  return (result.content as { type: string; text: string }[])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

function requestTool(grants: FolderGrant[], loanArrivalMs = 0) {
  const requests = new ShareRequestHub("s1", () => {});
  return {
    requests,
    tool: createShareRequestTool({
      grants: () => grants,
      requests,
      loanArrivalMs,
    }),
  };
}

function disconnectTool(grants: FolderGrant[]) {
  const requests = new ShareRequestHub("s1", () => {});
  return {
    requests,
    tool: createShareDisconnectTool({ grants: () => grants, requests }),
  };
}

Deno.test("share_request: a lent folder comes back by its /lend path", async () => {
  const grants: FolderGrant[] = [];
  const { requests, tool } = requestTool(grants);
  const answered = tool.execute("call-1", { reason: "read the CSV exports" });
  // The user lent one, and the announcement reached the server: the tool
  // names the path the model can address, and says how commands behave there.
  grants.push(grantOf("exports"));
  requests.finishLend("call-1");
  const body = text(await answered);
  assert(body.includes("/lend/exports"), body);
  assert(body.includes("read-only"), body);
  assert(body.includes("absolute path"), body);
});

Deno.test("share_request: a refusal says to continue without asking again", async () => {
  const grants: FolderGrant[] = [];
  const { requests, tool } = requestTool(grants);
  const answered = tool.execute("call-1", { reason: "read the CSV exports" });
  requests.decline("call-1");
  const body = text(await answered);
  assert(body.includes("did not lend"), body);
  assert(body.includes("do not ask again"), body);
});

Deno.test("share_request: the reason is what the card shows, so it must be there", async () => {
  const { tool } = requestTool([]);
  await assertRejects(
    () => tool.execute("call-1", { reason: "   " }),
    CoreError,
    "must not be empty",
  );
  await assertRejects(
    () =>
      tool.execute("call-1", {
        reason: "x".repeat(MAX_SHARE_REASON_CHARS + 1),
      }),
    CoreError,
    "at most",
  );
});

Deno.test("share_request: a second card while one stands is refused", async () => {
  const grants: FolderGrant[] = [];
  const { requests, tool } = requestTool(grants);
  const first = tool.execute("call-1", { reason: "read the exports" });
  await assertRejects(
    () => tool.execute("call-2", { reason: "write the report" }),
    CoreError,
    "already being asked",
  );
  requests.finishLend("call-1");
  await first;
});

Deno.test("share_disconnect: the loan ends, and the folder is gone afterwards", async () => {
  const grants: FolderGrant[] = [grantOf("proj")];
  const { requests, tool } = disconnectTool(grants);
  const answered = tool.execute("call-1", { name: "proj" });
  // The desktop app withdrew it: the announcement took the grant away.
  grants.length = 0;
  requests.finishDisconnect("call-1");
  const body = text(await answered);
  assert(body.includes("/lend/proj"), body);
  assert(body.includes("no longer reachable"), body);
});

Deno.test("share_disconnect: an unknown name answers with what is lent", async () => {
  const grants: FolderGrant[] = [grantOf("proj"), grantOf("exports", true)];
  const { tool } = disconnectTool(grants);
  const body = text(await tool.execute("call-1", { name: "notes" }));
  assert(body.includes("No folder named notes"), body);
  assert(body.includes("/lend/proj"), body);
  assert(body.includes("/lend/exports"), body);
});

Deno.test("share_disconnect: the path is refused, and the name is named", async () => {
  // The lent-folder notice shows absolute paths, so the model reaches for one;
  // converting it silently would teach it the wrong argument, so the answer
  // says what the tool takes.
  const grants: FolderGrant[] = [grantOf("proj")];
  const { tool } = disconnectTool(grants);
  await assertRejects(
    () => tool.execute("call-1", { name: "/lend/proj" }),
    CoreError,
    'is "proj"',
  );
});

Deno.test("share_disconnect: the app's failure is quoted, and the folder stays lent", async () => {
  const grants: FolderGrant[] = [grantOf("proj")];
  const { requests, tool } = disconnectTool(grants);
  const answered = tool.execute("call-1", { name: "proj" });
  requests.failDisconnect("call-1", "the shell refused");
  const body = text(await answered);
  assert(body.includes("the shell refused"), body);
  assert(body.includes("still lent"), body);
});

Deno.test("share_disconnect: silence from the desktop app leaves the folder lent", async () => {
  // The deadline, not a torn-down run: the tool resolves and says what is
  // still true, so the model does not report a loan it did not end.
  const grants: FolderGrant[] = [grantOf("proj")];
  const requests = new ShareRequestHub("s1", () => {}, { disconnect: 5 });
  const tool = createShareDisconnectTool({
    grants: () => grants,
    requests,
  });
  const body = text(await tool.execute("call-1", { name: "proj" }));
  assert(body.includes("did not answer within 30 seconds"), body);
  assert(body.includes("still lent"), body);
  assertEquals(grants.length, 1);
});

Deno.test("share_request: a loan that has not arrived is said, not guessed", async () => {
  const grants: FolderGrant[] = [];
  const { requests, tool } = requestTool(grants);
  const answered = tool.execute("call-1", { reason: "read the exports" });
  requests.finishLend("call-1");
  const body = text(await answered);
  assert(body.includes("has not reached the server yet"), body);
  // No path is invented for a folder the server has not heard of.
  assertEquals(body.includes("/lend/exports"), false, body);
});

Deno.test("share_request: an ending run rejects rather than answering", async () => {
  const { requests, tool } = requestTool([]);
  const answered = tool.execute("call-1", { reason: "read the exports" });
  requests.cancelAll();
  await assertRejects(() => answered, CoreError);
  assertEquals(requests.pendingShareRequest(), null);
});
