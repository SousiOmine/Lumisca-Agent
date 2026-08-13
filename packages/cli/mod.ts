import { LumiscaCore } from "@lumisca/core";
import { runRepl } from "./repl.ts";
import { pickWorkspace, selectFromList, sessionLabel } from "./select.ts";
import { createSession } from "./session.ts";
import { error, errorText, info } from "./ui.ts";
import {
  HelpRequested,
  parseRunArgs,
  printRunResult,
  RUN_USAGE,
  runOnce,
} from "./run.ts";

const USAGE = `Lumisca CLI

使用法:
  lumisca                     対話モード(ワークスペース/セッション選択から開始)
  lumisca --workspace <name>  指定ワークスペースで開始
  lumisca --resume            セッション選択から開始
  lumisca --session <id>      セッションIDで開始
  lumisca run [options]       ワンショット実行(ヘッドレス)

オプション:
  --db <path>       データベースのパス(既定: ./lumisca.db または $LUMISCA_DB)

サブコマンド:
  run                詳細は "lumisca run --help" を参照
`;

interface CliOptions {
  dbPath: string;
  workspaceName?: string;
  resume: boolean;
  sessionId?: string;
}

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    dbPath: Deno.env.get("LUMISCA_DB") ?? `${Deno.cwd()}/lumisca.db`,
    resume: false,
  };

  // Flag names this parser knows. flagValue treats a following known flag
  // as a missing value, but accepts other "--"-prefixed text as a value.
  const KNOWN_FLAGS = new Set([
    "--db",
    "--workspace",
    "--resume",
    "--session",
    "--help",
    "-h",
  ]);

  /** Read the value of a flag that takes an argument; exits on missing value. */
  const flagValue = (flag: string, i: number): string => {
    const value = args[i + 1];
    if (value === undefined || KNOWN_FLAGS.has(value)) {
      error(`--${flag} には値が必要です`);
      Deno.exit(1);
    }
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // `deno task cli -- <flags>` inserts a "--" separator; skip it (there
    // are no positional args, so flags after it are parsed normally).
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      Deno.exit(0);
    }
    switch (arg) {
      case "--db":
        opts.dbPath = flagValue("db", i++);
        break;
      case "--workspace":
        opts.workspaceName = flagValue("workspace", i++);
        break;
      case "--resume":
        opts.resume = true;
        break;
      case "--session":
        opts.sessionId = flagValue("session", i++);
        break;
      default:
        error(`不明な引数: ${arg}`);
        console.log(USAGE);
        Deno.exit(1);
    }
  }
  return opts;
}

/** The one-shot `lumisca run` path: parse args, execute the run, print
 * the result, and return the process exit code. The core is closed in the
 * finally block before the code leaves this function — exiting from inside
 * the try (Deno.exit) would skip it and orphan MCP server processes. */
async function runCommand(args: string[]): Promise<number> {
  let options;
  try {
    options = parseRunArgs(args);
  } catch (e) {
    if (e instanceof HelpRequested) {
      console.log(RUN_USAGE);
      return 0;
    }
    error(errorText(e));
    console.log(RUN_USAGE);
    return 1;
  }
  const core = LumiscaCore.open(options.dbPath);
  try {
    const result = await runOnce(core, options);
    printRunResult(result, options.json);
    if (result.error) {
      error(`エラー: ${result.error}`);
      return 1;
    }
    return 0;
  } catch (e) {
    error(errorText(e));
    return 1;
  } finally {
    core.close();
  }
}

async function main(): Promise<number> {
  const args = Deno.args;
  if (args[0] === "run") {
    return await runCommand(args.slice(1));
  }
  const opts = parseArgs(args);
  const core = LumiscaCore.open(opts.dbPath);

  // Ctrl+C: close the database and abort live agents instead of dying
  // mid-write (runRepl's finally would not run on SIGINT).
  Deno.addSignalListener("SIGINT", () => {
    console.log("\n終了します");
    core.close();
    Deno.exit(130);
  });

  try {
    // Direct session id
    if (opts.sessionId) {
      const session = core.getSession(opts.sessionId);
      if (!session) {
        error(`セッションが見つかりません: ${opts.sessionId}`);
        return 1;
      }
      await core.openSession(session.id);
      await runRepl(core, session.id);
      return 0;
    }

    // Workspace selection
    let workspaceId: string | null = null;
    if (opts.workspaceName) {
      const ws = core.listWorkspaces().find((w) =>
        w.name === opts.workspaceName
      );
      if (ws) {
        workspaceId = ws.id;
      } else {
        error(`ワークスペースが見つかりません: ${opts.workspaceName}`);
        return 1;
      }
    } else {
      workspaceId = await pickWorkspace(core);
    }
    if (workspaceId === null) return 0;

    // Session selection
    let sessionId: string | null = null;
    if (opts.resume) {
      const sessions = core.listSessions(workspaceId);
      if (sessions.length === 0) {
        info("このワークスペースにはセッションがありません。新規作成します。");
      } else {
        sessionId = await selectFromList(
          "セッションを選択",
          sessions.map((s) => ({
            label: sessionLabel(s),
            value: s.id,
          })),
        );
      }
    }

    if (!sessionId) {
      // new session (also the default path)
      sessionId = await createSession(core, workspaceId);
      if (!sessionId) return 0;
    }

    await core.openSession(sessionId);
    await runRepl(core, sessionId);
    return 0;
  } finally {
    core.close();
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
