import { LumiscaCore } from "@lumisca/core";
import { runRepl } from "./repl.ts";
import { pickModel, pickWorkspace, selectFromList } from "./select.ts";
import { color, error, header, info, success } from "./ui.ts";

const USAGE = `Lumisca CLI

使用法:
  lumisca                     対話モード(ワークスペース/セッション選択から開始)
  lumisca --workspace <name>  指定ワークスペースで開始
  lumisca --resume            セッション選択から開始
  lumisca --session <id>      セッションIDで開始
  lumisca --new               新しいセッションを作成して開始

オプション:
  --db <path>       データベースのパス(既定: ./lumisca.db または $LUMISCA_DB)
`;

interface CliOptions {
  dbPath: string;
  workspaceName?: string;
  resume: boolean;
  newSession: boolean;
  sessionId?: string;
}

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    dbPath: Deno.env.get("LUMISCA_DB") ?? `${Deno.cwd()}/lumisca.db`,
    resume: false,
    newSession: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--db":
        opts.dbPath = args[++i]!;
        break;
      case "--workspace":
        opts.workspaceName = args[++i]!;
        break;
      case "--resume":
        opts.resume = true;
        break;
      case "--new":
        opts.newSession = true;
        break;
      case "--session":
        opts.sessionId = args[++i]!;
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        Deno.exit(0);
      default:
        error(`不明な引数: ${arg}`);
        console.log(USAGE);
        Deno.exit(1);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(Deno.args);
  const core = LumiscaCore.open(opts.dbPath);

  try {
    // Direct session id
    if (opts.sessionId) {
      const session = core.getSession(opts.sessionId);
      if (!session) {
        error(`セッションが見つかりません: ${opts.sessionId}`);
        return;
      }
      await core.openSession(session.id);
      await runRepl(core, session.id);
      return;
    }

    // Workspace selection
    let workspaceId: string | null = null;
    if (opts.workspaceName) {
      const ws = core.listWorkspaces().find((w) => w.name === opts.workspaceName);
      if (ws) {
        workspaceId = ws.id;
      } else {
        error(`ワークスペースが見つかりません: ${opts.workspaceName}`);
        return;
      }
    } else {
      workspaceId = await pickWorkspace(core);
    }
    if (workspaceId === null) return;

    // Session selection
    let sessionId: string | null = null;
    if (opts.sessionId) {
      sessionId = opts.sessionId;
    } else if (opts.resume) {
      const sessions = core.listSessions(workspaceId);
      if (sessions.length === 0) {
        info("このワークスペースにはセッションがありません。新規作成します。");
      } else {
        sessionId = await selectFromList(
          "セッションを選択",
          sessions.map((s) => ({
            label: `${s.name} ${color.faint(`${s.modelProvider}/${s.modelId}`)}`,
            value: s.id,
          })),
        );
      }
    }

    if (!sessionId) {
      // new session (also the default path)
      const model = await pickModel(core);
      if (!model) return;
      const session = core.createSession({
        workspaceId,
        modelProvider: model.providerId,
        modelId: model.modelId,
      });
      success(`セッション作成: ${session.id} (${model.providerId}/${model.modelId})`);
      sessionId = session.id;
    }

    await core.openSession(sessionId);
    await runRepl(core, sessionId);
  } finally {
    core.close();
  }
}

if (import.meta.main) {
  await main();
}
