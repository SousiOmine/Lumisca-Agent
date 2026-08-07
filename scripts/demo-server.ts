import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { contentText, LumiscaCore } from "../packages/core/mod.ts";
import { startServer } from "../packages/server/app.ts";

const faux = fauxProvider();
const core = LumiscaCore.forTesting([faux.provider]);

const ws = await core.createWorkspace("E2E Demo", [Deno.cwd()]);
core.createSession({
  workspaceId: ws.id,
  name: "e2e-session",
  modelProvider: faux.provider.id,
  modelId: faux.getModel().id,
});

faux.setResponses([
  (ctx) => {
    const last = ctx.messages.at(-1);
    if (last?.role === "toolResult") {
      const content = contentText(
        last.content as Array<{ type: string; text?: string }>,
      );
      return fauxAssistantMessage(
        `ツールの実行結果を確認しました: ${
          content.slice(0, 80)
        }\n\nタスクは完了です。`,
      );
    }
    const text = contentText(
      (last?.content ?? []) as Array<{ type: string; text?: string }>,
    );
    if (text.includes("bash")) {
      return fauxAssistantMessage([
        fauxText("ディレクトリを確認します。"),
        fauxToolCall("bash", { command: "dir", timeout: 30 }),
      ]);
    }
    if (text.includes("read")) {
      return fauxAssistantMessage([
        fauxText("README.md を読みます。"),
        fauxToolCall("read_file", { path: "README.md" }),
      ]);
    }
    return fauxAssistantMessage(
      "## デモ応答\n\nこれはマークダウンのテストです:\n\n" +
        "```ts\nconst x = 1;\n```\n\n" +
        "- 項目A\n- 項目B\n\n" +
        "[pi](https://pi.dev) と <script>alert(1)</script> のテスト。",
    );
  },
]);

const server = startServer(core, 8000, {
  repoRoot: Deno.cwd(),
});
console.log("E2E demo server on http://127.0.0.1:8000");
Deno.addSignalListener("SIGINT", () => {
  server.shutdown();
  core.close();
  Deno.exit(0);
});
