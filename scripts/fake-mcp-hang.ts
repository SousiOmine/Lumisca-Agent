// Fake MCP server that never answers, for the settings-UI probe tests: it
// swallows every JSON-RPC message, so a client's initialize handshake can
// only end in a timeout (the fake-mcp-server.ts fixture answers instead).
//
// The tests also check that a timed-out probe shuts the server down, hence
// the exit marker: the transport stops this process by ending stdin (EOF)
// or, when it does not exit in time, by a signal. EOF is the normal path.
//
// Run with: deno run --allow-write scripts/fake-mcp-hang.ts <marker-file>

const marker = Deno.args[0];

function finish(): never {
  if (marker !== undefined) {
    try {
      Deno.writeTextFileSync(marker, "exited");
    } catch {
      // A missing marker fails the test that asked for it.
    }
  }
  Deno.exit(0);
}

// SIGTERM is the SDK's fallback kill. Best-effort only: not every platform
// delivers it, and Windows refuses listeners for unsupported signals.
try {
  Deno.addSignalListener("SIGTERM", finish);
} catch {
  // unsupported here — stdin EOF still ends this process
}

// Swallow everything: no response is ever written.
for await (const chunk of Deno.stdin.readable) {
  if (chunk.length === 0) break;
}
// stdin EOF: the client closed the transport.
finish();
