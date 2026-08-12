// Test helper: seed a long chat history into a session so the layout can be
// verified with many messages. Run with:
//   deno run -A scripts/seed-test-history.ts <sessionId> [nPairs]
// The DB path follows the server convention (LUMISCA_DB, default test-lumisca.db).
import { DatabaseSync } from "node:sqlite";

const sessionId = Deno.args[0];
const nPairs = Number(Deno.args[1] ?? 12);
if (!sessionId) {
  console.error("usage: seed-test-history.ts <sessionId> [nPairs]");
  Deno.exit(1);
}

const db = new DatabaseSync(Deno.env.get("LUMISCA_DB") ?? "test-lumisca.db");
const insert = db.prepare(
  "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
);

let ts = 1785633377599;
let n = 0;
for (let i = 1; i <= nPairs; i++) {
  ts += 60_000;
  const userText =
    `テスト質問 ${i} です。この会話は履歴が長くなったときのレイアウトを確認するためのものです。ダミーの質問文を何行かにわたって書いています。これは ${i} 回目のやりとりです。`;
  insert.run(
    `msg-u-${i}`,
    sessionId,
    "user",
    JSON.stringify({
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: ts,
    }),
    ts,
  );
  n++;

  ts += 90_000;
  let paragraphs = "";
  for (let j = 1; j <= 30; j++) {
    paragraphs +=
      ` ダミーパラグラフ ${i}-${j} です。履歴が長くなったときのスクロール挙動を確認するための文章です。`;
  }
  const answerText =
    `回答 ${i} です。長い履歴になるとレイアウトがどうなるかを確認するためのダミー回答です。${paragraphs}`;
  insert.run(
    `msg-a-${i}`,
    sessionId,
    "assistant",
    JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: answerText }],
      api: "openai-completions",
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      usage: { input: 100, output: 50 },
      timestamp: ts,
    }),
    ts,
  );
  n++;

  // One assistant message with two tool calls, each followed by a tool
  // result, so restored-session rendering of tool calls can be verified.
  ts += 30_000;
  const callIds = [`call_t${i}_a`, `call_t${i}_b`];
  insert.run(
    `msg-t-${i}`,
    sessionId,
    "assistant",
    JSON.stringify({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: callIds[0]!,
          name: "list_dir",
          arguments: { path: "." },
        },
        {
          type: "toolCall",
          id: callIds[1]!,
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
      api: "openai-completions",
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      usage: { input: 100, output: 50 },
      timestamp: ts,
    }),
    ts,
  );
  n++;
  for (let k = 0; k < callIds.length; k++) {
    ts += 20_000;
    insert.run(
      `msg-tr-${i}-${k}`,
      sessionId,
      "toolResult",
      JSON.stringify({
        role: "toolResult",
        toolCallId: callIds[k]!,
        toolName: k === 0 ? "list_dir" : "read",
        content: [{
          type: "text",
          text:
            `ツール実行結果 ${i}-${k} です。ダミーの実行結果テキストが入ります。${
              "ダミー行です。".repeat(10)
            }`,
        }],
        timestamp: ts,
      }),
      ts,
    );
    n++;
  }
}

console.log(`seeded ${n} messages into ${sessionId}`);
db.close();
