/**
 * Manual probe for the folder loan, lending side.
 *
 * Attaches a lender to a RUNNING server and lends one folder to one session,
 * which is the whole feature without the desktop app's UI (the shell's grant
 * registry is the next step; see ARCHITECTURE.md). The agent then reads and
 * writes that folder through the ordinary file tools, and this process prints
 * every call it serves.
 *
 * The session id is the conversation's, not the agent's: in stella mode it is
 * the `sessionId` of the conversation snapshot, in code mode the tab's
 * session. Open the conversation first, then run this in another terminal:
 *
 *   bun run probe:share --url http://127.0.0.1:8000 --session <id> \
 *     --folder ~/Documents/proj [--token <token>] [--write] [--exec] \
 *     [--minutes 30]
 *
 * Without `--write` the loan is read-only; without `--exec` commands cannot
 * run there. Prompt the agent ("read README.md in the folder I lent you") and
 * watch the calls arrive. Ctrl-C ends the loan.
 */
import { realpathSync } from "node:fs";
import { createShareHost } from "../packages/server/share-host.ts";

interface Args {
  url: string;
  session: string;
  folder: string;
  token: string;
  write: boolean;
  exec: boolean;
  minutes: number;
}

const USAGE = [
  "使い方: bun run probe:share --url <url> --session <id> --folder <path> [--token <token>] [--write] [--exec] [--minutes 30]",
  "  --write    エージェントに書き込みを許します（既定は読み取りのみ）",
  "  --exec     そのフォルダでコマンドを実行させます（既定は不許可）",
].join("\n");

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      i += 1;
    } else {
      flags.add(name);
    }
  }
  const url = values.get("url");
  const session = values.get("session");
  const folder = values.get("folder");
  if (url === undefined || session === undefined || folder === undefined) {
    throw new Error(USAGE);
  }
  const minutes = Number(values.get("minutes") ?? "30");
  return {
    url,
    session,
    folder: realpathSync.native(folder),
    token: values.get("token") ?? "",
    write: flags.has("write"),
    exec: flags.has("exec"),
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 30,
  };
}

const args = parseArgs(process.argv.slice(2));
const grant = {
  id: `probe-${crypto.randomUUID().slice(0, 8)}`,
  sessionId: args.session,
  path: args.folder,
  write: args.write,
  exec: args.exec,
  expiresAt: Date.now() + args.minutes * 60_000,
};

const lender = createShareHost({
  log: (line) => console.log(`[share] ${line}`),
});
lender.command(
  JSON.stringify({ type: "hello", url: args.url, token: args.token }),
);
lender.command(JSON.stringify({ type: "grants", grants: [grant] }));

console.log(`貸出中: ${args.folder}`);
console.log(
  `  宛先: ${args.url}  session=${args.session}  ` +
    `${args.write ? "読み書き" : "読み取りのみ"} / ` +
    `${args.exec ? "コマンド可" : "コマンド不可"}`,
);
console.log(`  ${args.minutes} 分で失効します（Ctrl-C で取り消し）`);

const stop = () => {
  lender.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Keep the process (and the loan) alive until the user stops it.
await new Promise(() => {});
