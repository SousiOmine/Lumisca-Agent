/**
 * Everything the `service` command decides *about* the machine it runs on,
 * plus the command line that drives it — separated from the verbs themselves
 * (mod.ts) so the whole decision surface is testable without systemd, a
 * packaged binary, or a Linux host.
 *
 * Two rules from the launcher side live here as well: only a packaged server
 * owns an installation (a `deno run` server is the repository, and the
 * desktop shell's copy is replaced by the app's own updater), and a
 * non-loopback bind must name the authorities clients will use.
 */
import { dirname, join } from "node:path";
import { SETTINGS_DIR_NAME } from "@lumisca/core";
import { parsePortValue } from "../startup.ts";
import type { LaunchFlags, ServicePaths } from "./compose.ts";
import { hasControlCharacter, splitHosts } from "./document.ts";

/** Unit name of the installation (`lumisca.service`, a user unit). */
export const UNIT_NAME = "lumisca.service";

/** EnvironmentFile name, beside the settings file it configures. */
export const DOCUMENT_NAME = "service.env";

/** What `service` needs to know about the machine it runs on, injected so
 * every decision is testable. */
export interface ServiceHost {
  /** `Deno.build.os`. */
  os: string;
  /** `Deno.build.standalone`: only a packaged server owns its installation. */
  standalone: boolean;
  /** `LUMISCA_DESKTOP` was set: the desktop shell owns this binary. */
  desktopManaged: boolean;
  /** `Deno.execPath()`. */
  execPath: string;
  /** HOME the unit sets (the server resolves its settings file under it). */
  home: string;
  /** Unix user the unit runs as (`loginctl enable-linger`). */
  user: string;
  /** Directory a relative `--db` resolves against. */
  cwd: string;
  /** XDG_CONFIG_HOME of this shell, or undefined for `<home>/.config`. */
  xdgConfigHome: string | undefined;
}

export type ServiceVerb =
  | "install"
  | "config"
  | "status"
  | "uninstall"
  | "help";

export interface ServiceInvocation {
  verb: ServiceVerb;
  flags: LaunchFlags;
  /** `config --defaults`: the shipped template alone, without the installed
   * layer. */
  defaults: boolean;
}

/** A command line the launcher cannot act on (reported as a usage error, the
 * way an unknown launcher verb is). */
export class ServiceUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceUsageError";
  }
}

export const SERVICE_USAGE =
  `lumisca-server service — systemd ユーザーユニットとして常駐させます

使い方:
  lumisca-server service install [options]   ユニットを書き込み、有効化して起動します
  lumisca-server service config  [options]   書き込む内容を表示します (何も変更しません)
  lumisca-server service status              設置状態・ドリフト・接続先を表示します
  lumisca-server service uninstall           停止してユニットを削除します

オプション (install / config):
  --host <addr>           待ち受けアドレス (既定: 127.0.0.1)
  --port <n>              待ち受けポート (既定: 8000)
  --db <path>             データベースのパス (既定: <インストール先>/lumisca.db)
  --allowed-hosts <list>  ループバック以外で許可するホスト名/IP (カンマ区切り、複数指定可)
  --token <value>         クライアント用トークン (既定: 初回に生成し、以後は引き継ぎます)
  --defaults              (config のみ) 同梱テンプレートだけを表示します
  -h, --help              このヘルプ

ループバック以外を --host に指定するときは --allowed-hosts が必須です
(Host ガードは伝えられていないホスト名を拒否するため)。

指定しなかった値は、設置済みの service.env の値が使われます。
終了コード: 0=成功, 1=実行失敗, 2=引数・環境のエラー
`;

/** Files of this installation's service definition. */
export function servicePaths(host: ServiceHost): ServicePaths {
  const configHome = host.xdgConfigHome ?? join(host.home, ".config");
  return {
    unitPath: join(configHome, "systemd", "user", UNIT_NAME),
    documentPath: join(configHome, SETTINGS_DIR_NAME, DOCUMENT_NAME),
    installDir: dirname(host.execPath),
    home: host.home,
    execPath: host.execPath,
  };
}

function requireVerb(value: string): ServiceVerb {
  if (
    value === "install" || value === "config" || value === "status" ||
    value === "uninstall"
  ) {
    return value;
  }
  throw new ServiceUsageError(`不明なサブコマンドです: ${value}`);
}

/** A value that must not be empty, whitespace, or a control character. */
function requireValue(flag: string, value: string): string {
  if (value === "" || /\s/.test(value) || hasControlCharacter(value)) {
    throw new ServiceUsageError(`${flag} の値が不正です: "${value}"`);
  }
  return value;
}

/** A token travels in a URL query (`?token=…`), so it stays printable ASCII
 * without whitespace. */
function requireToken(value: string): string {
  if (!/^[!-~]+$/.test(value)) {
    throw new ServiceUsageError(
      `${"--token"} は空白を含まない半角英数字と記号で指定してください`,
    );
  }
  return value;
}

function requirePort(value: string): number {
  try {
    return parsePortValue(value);
  } catch (error) {
    throw new ServiceUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Parse the arguments after `service`. Every unknown option and every option
 * that belongs to another verb is a usage error (never a value to ignore): a
 * silently ignored `--port` would install a server on the default port while
 * the operator believes otherwise.
 */
export function parseServiceArgs(
  args: readonly string[],
): ServiceInvocation {
  const flags: LaunchFlags = {};
  let verb: ServiceVerb | undefined;
  let defaults = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") {
      return { verb: "help", flags: {}, defaults: false };
    }
    if (arg.startsWith("--")) {
      const separator = arg.indexOf("=");
      const name = separator === -1 ? arg : arg.slice(0, separator);
      const inline = separator === -1 ? undefined : arg.slice(separator + 1);
      const takeValue = (): string => {
        if (inline !== undefined) return inline;
        const next = args[index + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new ServiceUsageError(`${name} には値が必要です`);
        }
        index++;
        return next;
      };
      switch (name) {
        case "--host":
          flags.host = requireValue(name, takeValue());
          break;
        case "--port":
          flags.port = requirePort(takeValue());
          break;
        case "--db":
          flags.db = takeValue();
          if (flags.db === "") {
            throw new ServiceUsageError(`${name} を空にできません`);
          }
          break;
        case "--allowed-hosts": {
          const hosts = splitHosts(takeValue());
          if (hosts.length === 0) {
            throw new ServiceUsageError(`${name} を空にできません`);
          }
          for (const host of hosts) requireValue(name, host);
          flags.allowedHosts = [...(flags.allowedHosts ?? []), ...hosts].filter(
            (host, position, all) => all.indexOf(host) === position,
          );
          break;
        }
        case "--token":
          flags.token = requireToken(takeValue());
          break;
        case "--defaults":
          if (inline !== undefined) {
            throw new ServiceUsageError(`${name} は値を受け取りません`);
          }
          defaults = true;
          break;
        default:
          throw new ServiceUsageError(`不明なオプションです: ${name}`);
      }
      continue;
    }
    if (verb !== undefined) {
      throw new ServiceUsageError(`不明な引数です: ${arg}`);
    }
    verb = requireVerb(arg);
  }

  if (verb === undefined) {
    throw new ServiceUsageError("サブコマンドを指定してください");
  }
  if (verb === "status" || verb === "uninstall") {
    if (Object.keys(flags).length > 0) {
      throw new ServiceUsageError(
        `${verb} はオプションを受け取りません (--host 等は install でのみ指定します)`,
      );
    }
  }
  if (defaults && verb !== "config") {
    throw new ServiceUsageError("--defaults は config でのみ使えます");
  }
  if (defaults && Object.keys(flags).length > 0) {
    throw new ServiceUsageError(
      "--defaults は同梱テンプレートだけを表示するため、他のオプションと併用できません",
    );
  }
  return { verb, flags, defaults };
}
