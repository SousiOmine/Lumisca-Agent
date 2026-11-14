/**
 * The reported bug, end to end through a real core.
 *
 * A stella conversation adds an MCP server that needs a sign-in, the user
 * signs in from Settings, and the conversation still cannot call its tools.
 * Two separate faults made that true:
 *
 *   1. The sign-in reconnected nothing. `SessionPool.refreshMcp` asserts
 *      "not streaming" for every listed session before it does anything, so
 *      one running conversation made the whole batch throw — and
 *      `McpService.refreshSessionsUsing` swallowed the error. Nothing
 *      retried: the sign-in changes no config, so no later rebuild would
 *      pick the grant up either.
 *
 *   2. The conversation it had to reconnect was not even in the list.
 *      `McpService` is given `SessionRepo.list()`, which excludes stella's
 *      row (`WHERE stella = 0`) because stella has no session in the UI. So
 *      even with (1) fixed, a stella conversation was never among the
 *      sessions a sign-in refreshed.
 *
 * The test drives the whole path: a server that answers 401 until a token
 * exists, a stella conversation, the sign-in the user walks through, and the
 * tools the conversation can finally discover.
 */
import { assert, assertEquals } from "@std/assert";
import { fauxProvider } from "../ai/faux.ts";
import { LumiscaCore } from "../core.ts";
import { startFakeAuthServer, startFakeMcpServer } from "./fake-http.ts";
import type { McpServerStatus } from "./manager.ts";

/** Discovery runs in the background (the attachment connects the servers and
 * lists their tools); the core reports it when it settles. Polling is what a
 * client does too, through the status it reads. */
async function waitForStatus(
  read: () => McpServerStatus[] | null,
  ready: (servers: McpServerStatus[]) => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<McpServerStatus[]> {
  const deadline = Date.now() + timeoutMs;
  let last: McpServerStatus[] = [];
  while (Date.now() < deadline) {
    last = read() ?? [];
    if (last.length > 0 && ready(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `${what} never happened: ${JSON.stringify(
      last.map((s) => ({
        name: s.name,
        tools: s.toolCount,
        needsAuth: s.needsAuth,
        error: s.error,
      })),
    )}`,
  );
}

Deno.test("E2E: a stella conversation reaches an MCP server after signing in", async () => {
  const auth = startFakeAuthServer();
  const mcp = startFakeMcpServer({
    token: "access-token-1",
    authorizationServerUrl: auth.url,
  });
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  core.models.models.setProvider(faux.provider);
  await core.setProviderApiKey(faux.provider.id, "k");
  core.setStellaVm({
    status: () =>
      Promise.resolve({
        state: "running" as never,
        vncPort: 49153,
        reason: "",
      }),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    vncPort: () => Promise.resolve(49153),
    startDesktop: () => Promise.resolve(),
    stopDesktop: () => Promise.resolve(),
  } as never);
  try {
    const agent = await core.createStellaAgent({ name: "Aide", role: "help" });
    const session = await core.getOrCreateStellaSession(agent.id);
    const body = JSON.stringify({ mcpServers: { probe: { url: mcp.url } } });
    const status = () =>
      core.getSession(session.id) === undefined
        ? null
        : ((
            core as unknown as {
              pool: {
                get(
                  id: string,
                ): { getMcpStatus(): McpServerStatus[] | null } | undefined;
              };
            }
          ).pool
            .get(session.id)
            ?.getMcpStatus() ?? null);

    // 1. Added while the conversation exists. Without a grant the server
    //    answers 401: it is configured, enabled and unreachable.
    core.services.mcp.setAppMcpConfig(body);
    // Discovery has to have run before "needs a sign-in" means anything: a
    // status read taken before it starts says "enabled, 0 tools".
    const before = await waitForStatus(
      status,
      (servers) => servers.some((s) => s.needsAuth === true),
      "the 401 the server answers without a grant",
    );
    assert(before[0]?.needsAuth === true);

    // 2. The sign-in the user walks through in Settings.
    const started = await core.startMcpAuth(
      body,
      "http://127.0.0.1:8000/api/mcp/oauth/callback",
    );
    const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
    const done = await core.completeMcpAuth({ state, code: "test-code" });
    assertEquals(done?.status, "done");

    // 3. The conversation's own attachment is reconnected, and the server it
    //    could not reach before now hands out its tools.
    const after = await waitForStatus(
      status,
      (servers) => servers.every((s) => s.toolCount === 1),
      "the server's tools after signing in",
    );
    assertEquals(
      after.map((s) => s.name),
      ["probe"],
    );
    assertEquals(after[0]?.needsAuth, undefined, "the sign-in cleared 401");
    assertEquals(after[0]?.toolCount, 1);
    // The same conversation, never rebuilt under the user.
    assertEquals(core.getSession(session.id)?.id, session.id);
  } finally {
    await core.close();
    await mcp.close();
    await auth.close();
  }
});
