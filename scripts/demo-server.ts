/**
 * Manual demo server: a Lumisca server whose agent runs on the faux
 * provider, so the web UI can be exercised (markdown rendering, tool
 * calls, XSS escaping) without an API key, network access, or a real
 * model.
 *
 * Run from the repository root (the optional argument overrides the port,
 * so the demo can run alongside a real server on 8000):
 *   deno run --allow-net --allow-read --allow-write --allow-env \
 *     --allow-run --allow-sys --allow-ffi scripts/demo-server.ts [port]
 *
 * Then open the printed URL, pick the "E2E Demo" workspace, and open the
 * "e2e-session" session. Prompts mentioning "bash" or "read" exercise the
 * matching tool; anything else answers with markdown.
 */
import { basename } from "node:path";
import {
  type AssistantMessage,
  contentText,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  LumiscaCore,
  type StreamRequest,
} from "../packages/core/mod.ts";
import { TOOL_BASH, TOOL_READ } from "../packages/core/shared/mod.ts";
import { startServer } from "../packages/server/app.ts";
import { repoRoot } from "./lib.ts";

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 8000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`port must be an integer in 1..65535 (got "${raw}")`);
  }
  return port;
}

const PORT = parsePort(Deno.args[0]);
/** Tool arguments are workspace-relative: the sandbox addresses a folder
 * by its directory name (`<folder>/<path>`), and `bash` takes the folder
 * as its required `cwd`. */
const folder = basename(repoRoot);
/** The demo's directory listing (the shell differs per OS). */
const LIST_COMMAND = Deno.build.os === "windows" ? "dir" : "ls -la";

/** Answer one LLM call from the transcript so far: a tool result ends the
 * run with a summary, a prompt mentioning a tool name calls it, and
 * anything else returns markdown for the UI. */
function respond(context: StreamRequest): AssistantMessage {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") {
    const result = contentText(last.content);
    return fauxAssistantMessage(
      `ツールの実行結果を確認しました: ${
        result.slice(0, 80)
      }\n\nタスクは完了です。`,
    );
  }
  const text = contentText(last?.content ?? "");
  if (text.includes(TOOL_BASH)) {
    return fauxAssistantMessage([
      fauxText("ディレクトリを確認します。"),
      fauxToolCall(TOOL_BASH, {
        cwd: folder,
        command: LIST_COMMAND,
        timeout: 30,
      }),
    ]);
  }
  if (text.includes(TOOL_READ)) {
    return fauxAssistantMessage([
      fauxText("README.md を読みます。"),
      fauxToolCall(TOOL_READ, { path: `${folder}/README.md` }),
    ]);
  }
  return fauxAssistantMessage(
    "## デモ応答\n\nこれはマークダウンのテストです:\n\n" +
      "```ts\nconst x = 1;\n```\n\n" +
      "- 項目A\n- 項目B\n\n" +
      "[Lumisca](https://github.com/SousiOmine/Lumisca-Agent) と " +
      "<script>alert(1)</script> のテスト。",
  );
}

const faux = fauxProvider();
const core = LumiscaCore.forTesting([faux.provider]);

// The faux provider serves exactly one queued response per LLM call, while
// this demo answers prompts indefinitely. Re-arm the responder at the two
// points where the loop is about to call the model — a run starting and a
// tool finishing — so every call (including the one after a tool result)
// finds a response.
const arm = () => faux.setResponses([respond]);
core.subscribe((event) => {
  if (event.type === "agent_start" || event.type === "tool_end") arm();
});
arm();

const ws = await core.createWorkspace("E2E Demo", [repoRoot]);
core.createSession({
  workspaceId: ws.id,
  name: "e2e-session",
  modelProvider: faux.provider.id,
  modelId: faux.getModel().id,
});

const server = startServer(core, PORT, { repoRoot });
console.log(`E2E demo server on http://127.0.0.1:${PORT}`);
console.log("workspace: E2E Demo / session: e2e-session");
Deno.addSignalListener("SIGINT", () => {
  console.log("\nShutting down...");
  server.shutdown();
  // Await the teardown so background commands and MCP child processes
  // are dead before the process exits.
  void core.close().then(() => Deno.exit(0));
});
