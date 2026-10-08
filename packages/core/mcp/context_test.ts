import { assertEquals } from "@std/assert";
import {
  createMcpToolsProvider,
  MCP_TOOLS_PROVIDER,
  ON_DEMAND_TOOLS_NOTE,
  withOnDemandToolsNote,
} from "./context.ts";

Deno.test("mcp context: publishes the note when the pair appears, once", () => {
  let searchable = false;
  const provider = createMcpToolsProvider({ searchable: () => searchable });
  assertEquals(provider.name, MCP_TOOLS_PROVIDER);

  // A session whose registry is empty has no pair to explain.
  assertEquals(provider.next(), []);

  searchable = true;
  const published = provider.next();
  assertEquals(published.length, 1);
  assertEquals(published[0]!.body, ON_DEMAND_TOOLS_NOTE);
  assertEquals(published[0]!.state, { available: true });

  // The pair is unchanged: nothing more is published.
  assertEquals(provider.next(), []);
});

Deno.test("mcp context: a disappeared pair is announced once", () => {
  let searchable = true;
  const provider = createMcpToolsProvider({ searchable: () => searchable });
  provider.next();

  searchable = false;
  const gone = provider.next();
  assertEquals(gone.length, 1);
  assertEquals(
    gone[0]!.body.includes("no longer available"),
    true,
    "the stale note must be withdrawn",
  );
  assertEquals(gone[0]!.state, { available: false });
  assertEquals(provider.next(), []);
});

Deno.test("mcp context: rebase re-anchors to the last publication", () => {
  let searchable = true;
  const provider = createMcpToolsProvider({ searchable: () => searchable });
  provider.rebase({ available: true });
  assertEquals(
    provider.next(),
    [],
    "a restored session that already published the note stays silent",
  );

  provider.rebase(undefined);
  assertEquals(provider.next().length, 1, "an unknown state republishes");

  // A session restored with the pair already gone announces nothing more.
  searchable = false;
  provider.rebase({ available: false });
  assertEquals(provider.next(), []);
});

Deno.test("on-demand note: the prompt form is idempotent", () => {
  const base = "You are a test agent.";
  const once = withOnDemandToolsNote(base);
  assertEquals(once.startsWith(base), true);
  assertEquals(once.includes(ON_DEMAND_TOOLS_NOTE), true);
  assertEquals(
    withOnDemandToolsNote(once),
    once,
    "a second attachment must not duplicate the note",
  );
  assertEquals(withOnDemandToolsNote(base), once);
});
