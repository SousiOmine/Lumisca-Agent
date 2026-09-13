/**
 * `lumisca-server service …`: the commands that make a packaged server
 * resident on a Linux machine, as a systemd *user* unit plus linger.
 *
 * Shape of the feature, and why it looks like this:
 *
 * - The unit is a user unit, so the agent (which runs arbitrary shell
 *   commands) runs as its owner, never as root, and needs no `sudo` to
 *   install. Only `loginctl enable-linger` may need it, and the install
 *   reports that as the one remaining step instead of hiding it.
 * - The shipped template is the first composition layer and the installed
 *   `service.env` the second, so `config` shows exactly what `install` would
 *   write, and reinstalling keeps the credential and the values the operator
 *   already has (compose.ts owns the order).
 * - Installing is the only thing that touches the system; every precondition
 *   (Linux, a packaged binary, a writable install directory, a free port) is
 *   checked first and reported as a clear failure, because the alternative is
 *   a restart loop under systemd's `Restart=always` with the reason buried in
 *   the journal.
 * - Supervision stays systemd's job: this module writes the definition and
 *   asks systemd to (re)start it. `LUMISCA_UPDATE_RESTART=supervisor` in the
 *   document is what tells an applied update to exit so systemd brings up the
 *   new binary (see update/service.ts).
 */

/** The unit template shipped in the server binary (template.ts). */
import { dirname, join } from "node:path";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DESKTOP_ENV_KEY,
  isAddressInUseError,
  isDesktopManaged,
} from "../startup.ts";
import { STAGING_DIR_NAME } from "../update/stage.ts";
import { renderUnit, resolveValues, type ServicePaths } from "./compose.ts";
import { SERVICE_UNIT_TEMPLATE } from "./template.ts";
import {
  DISPLAY_TOKEN,
  documentForDisplay,
  generateToken,
  parseDocument,
  renderDocument,
  ServiceDefinitionError,
  type ServiceLayer,
  type ServiceValues,
} from "./document.ts";
import {
  parseServiceArgs,
  SERVICE_USAGE,
  type ServiceHost,
  type ServiceInvocation,
  servicePaths,
  ServiceUsageError,
  UNIT_NAME,
} from "./plan.ts";
import {
  type CommandResult,
  createSystemdRunner,
  ServiceCommandError,
  type ServiceRunner,
} from "./runner.ts";

/** File the write-access check creates inside the updater's staging
 * directory. */
const WRITE_PROBE_NAME = ".write-test";

/** How long `install` waits for the started server to answer, and how often
 * it asks. */
const PROBE_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 10_000;

/** Everything the verbs need from the outside world, injected so the whole
 * command is testable without systemd, a packaged binary, or a network. */
export interface ServiceDeps {
  host: ServiceHost;
  runner: ServiceRunner;
  /** Health probe of the started server. */
  probe: (url: string, token: string) => Promise<boolean>;
  out: (line: string) => void;
  err: (line: string) => void;
  probeIntervalMs: number;
  probeTimeoutMs: number;
  /** Injected so a first install's credential stays testable. */
  generateToken: () => string;
  /** Network interfaces of this machine, for the connection URLs a wildcard
   * bind expands to (`Deno.networkInterfaces()`). */
  interfaces: () => Deno.NetworkInterfaceInfo[];
}

/** The real machine, the real systemd, and the real network. */
export function defaultServiceDeps(): ServiceDeps {
  const home = Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME") ?? "";
  if (home === "") {
    throw new ServiceUsageError(
      "HOME が設定されていません (ユニットの HOME を決められません)",
    );
  }
  const user = Deno.env.get("USER") ?? Deno.env.get("USERNAME") ?? "";
  if (user === "") {
    throw new ServiceUsageError(
      "ユーザー名を取得できません (USER / USERNAME が未設定です)",
    );
  }
  return {
    host: {
      os: Deno.build.os,
      standalone: Deno.build.standalone,
      desktopManaged: isDesktopManaged(Deno.env.get(DESKTOP_ENV_KEY)),
      execPath: Deno.execPath(),
      home,
      user,
      cwd: Deno.cwd(),
      xdgConfigHome: Deno.env.get("XDG_CONFIG_HOME") || undefined,
    },
    runner: createSystemdRunner(),
    probe: probeHealth,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    probeIntervalMs: PROBE_INTERVAL_MS,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    generateToken,
    interfaces: () => Deno.networkInterfaces(),
  };
}

/**
 * Run one `service` invocation and return the process exit code:
 * `0` success, `1` an action that failed, `2` a command line or environment
 * this installation cannot act on.
 *
 * Resolving this machine (HOME, the user, the paths) is part of the work, so
 * it happens inside the error mapping: a missing HOME must be reported here,
 * not escape as a rejection the process would swallow into a silent exit 0.
 */
export async function runServiceCommand(
  args: readonly string[],
  deps?: ServiceDeps,
): Promise<number> {
  let invocation: ServiceInvocation;
  try {
    invocation = parseServiceArgs(args);
  } catch (error) {
    if (error instanceof ServiceUsageError) {
      console.error(`lumisca-server service: ${error.message}\n`);
      console.error(SERVICE_USAGE);
      return 2;
    }
    throw error;
  }
  if (invocation.verb === "help") {
    console.log(SERVICE_USAGE);
    return 0;
  }

  let service: ServiceDeps | undefined;
  try {
    service = deps ?? defaultServiceDeps();
    const { verb } = invocation;
    if (verb === "config") return await runConfig(invocation, service);
    if (verb === "install") return await runInstall(invocation, service);
    if (verb === "status") return await runStatus(service);
    return await runUninstall(service);
  } catch (error) {
    // Without a resolved host there is no `err` to use yet; the fallback
    // writes to the console directly (the same stream the real one uses).
    const report = service?.err ?? ((line: string) => console.error(line));
    report(
      `lumisca-server service: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    if (
      error instanceof ServiceUsageError ||
      error instanceof ServiceDefinitionError
    ) {
      return 2;
    }
    return 1;
  }
} /** A packaged server owns its installation: a `deno run` server would put the
 * runtime's own path into the unit, and the desktop shell's copy is replaced
 * by the app's updater. */

function requirePackaged(deps: ServiceDeps): void {
  if (!deps.host.standalone) {
    throw new ServiceUsageError(
      "常駐化はパッケージ済みサーバーでのみ実行できます " +
        "(開発実行: deno run packages/server/mod.ts)",
    );
  }
}

/** A user unit needs systemd and a Linux home layout. */
function requireLinux(deps: ServiceDeps): void {
  if (deps.host.os !== "linux") {
    throw new ServiceUsageError(
      `systemd による常駐は Linux のみ対応です (現在: ${deps.host.os})`,
    );
  }
}

function requireNotDesktopManaged(deps: ServiceDeps): void {
  if (deps.host.desktopManaged) {
    throw new ServiceUsageError(
      "デスクトップアプリが起動するサーバーは常駐化できません " +
        `(${DESKTOP_ENV_KEY} が設定されています)`,
    );
  }
}

/** Fail fast on a systemd command that did not succeed: its stderr is the
 * operator's only explanation, so it is never swallowed. */
function expectOk(result: CommandResult, what: string): void {
  if (result.code === 0) return;
  const detail = result.stderr === "" ? result.stdout : result.stderr;
  throw new ServiceCommandError(
    `${what} に失敗しました (終了コード ${result.code}): ${detail}`,
  );
}

/** `systemctl --user daemon-reload` doubles as the reachability check for the
 * user bus: it is a no-op that fails loudly when systemd (or the connection
 * to the user manager) is missing, before anything is written. */
async function reloadSystemd(deps: ServiceDeps): Promise<void> {
  expectOk(
    await deps.runner.systemctl(["daemon-reload"]),
    "systemctl --user daemon-reload",
  );
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/** The layer-2 document, or an empty layer when nothing is installed yet. */
async function readInstalledDocument(
  paths: ServicePaths,
): Promise<ServiceLayer> {
  const text = await readTextIfPresent(paths.documentPath);
  return text === undefined ? {} : parseDocument(text);
}

/** Compose the three layers for an invocation. `generateToken` differs by
 * verb: `install` settles a real credential, `config` only displays. */
function composeValues(
  invocation: ServiceInvocation,
  deps: ServiceDeps,
  installed: ServiceLayer,
  generateTokenForVerb: () => string,
): ServiceValues {
  return resolveValues({
    installed,
    flags: invocation.flags,
    xdgConfigHome: deps.host.xdgConfigHome,
    defaults: { host: DEFAULT_HOST, port: DEFAULT_PORT },
    cwd: deps.host.cwd,
    generateToken: generateTokenForVerb,
  });
}

/**
 * Write the document atomically, readable only by its owner: a temp file in
 * the same directory created 0600, then renamed over the target. The file
 * system never holds the credential with wider permissions, and systemd never
 * reads a half-written document (a rename replaces the target on every
 * platform this runs on, POSIX and Windows alike).
 */
async function writeDocument(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  // A leftover temp file from an interrupted install is not worth failing
  // over: recreating it truncates it (the same reasoning as the updater's
  // removeQuietly).
  await Deno.remove(temporary).catch(() => {});
  // `writeTextFile` truncates unless `append` is set, which is what a
  // leftover temp file needs.
  await Deno.writeTextFile(temporary, text, {
    create: true,
    mode: 0o600,
  });
  await Deno.rename(temporary, path);
}

/**
 * The service must be able to write beside its binary: an applied update
 * stages its package in `<install dir>/.lumisca-update/`, and a default
 * database lands in the same directory. Checked by creating the staging area
 * the updater itself will use, so a read-only installation fails here with a
 * reason instead of looping under `Restart=always`.
 */
async function requireWritableInstallDir(paths: ServicePaths): Promise<void> {
  const staging = join(paths.installDir, STAGING_DIR_NAME);
  const probe = join(staging, WRITE_PROBE_NAME);
  try {
    await Deno.mkdir(staging, { recursive: true });
    await Deno.writeTextFile(probe, "");
    await Deno.remove(probe);
  } catch (error) {
    throw new ServiceDefinitionError(
      `インストール先に書き込めません (${paths.installDir}): ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        "自動更新のステージングとデータベースの作成に書き込み権限が必要です。" +
        "書き込み可能なディレクトリに展開し直してください。",
    );
  }
}

/** Whether the unit is running right now. */
async function isUnitActive(deps: ServiceDeps): Promise<boolean> {
  const result = await deps.runner.systemctl(["is-active", UNIT_NAME]);
  return result.stdout === "active";
}

/** Whether the unit is enabled (started with the user manager). */
async function isUnitEnabled(deps: ServiceDeps): Promise<boolean> {
  const result = await deps.runner.systemctl(["is-enabled", UNIT_NAME]);
  return result.stdout === "enabled";
}

/** Whether lingering is on: without it the unit starts at login, not at
 * boot. */
async function isLingerEnabled(deps: ServiceDeps): Promise<boolean> {
  const result = await deps.runner.loginctl([
    "show-user",
    deps.host.user,
    "-p",
    "Linger",
  ]);
  return result.code === 0 && result.stdout.includes("Linger=yes");
}

/** Address a client on this machine reaches a wildcard bind through. */
function localHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * Every base URL a client can use. A wildcard bind is expanded to this
 * machine's addresses, because that is the case where the operator cannot
 * guess the URL from the install output.
 */
export function connectionUrls(
  host: string,
  port: number,
  interfaces: readonly Deno.NetworkInterfaceInfo[],
): string[] {
  const hosts: string[] = [];
  if (host === "0.0.0.0" || host === "::") {
    hosts.push("127.0.0.1");
    for (const info of interfaces) {
      if (info.family !== "IPv4" || info.address.startsWith("127.")) continue;
      if (!hosts.includes(info.address)) hosts.push(info.address);
    }
  } else {
    hosts.push(localHost(host));
  }
  return hosts.map((entry) => `http://${entry}:${port}/`);
}

/** A URL that carries the credential, as the operator needs it to open the
 * UI from another device. */
function tokenUrl(base: string, token: string): string {
  return `${base}?token=${encodeURIComponent(token)}`;
}

/** Whether binding `host` here can be tested at all: an address this machine
 * does not own fails for a different reason, and reporting that as a port
 * conflict would be misleading. */
function isBindableHere(host: string, deps: ServiceDeps): boolean {
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return true;
  }
  if (host === "0.0.0.0" || host === "::") return true;
  return deps.interfaces().some((info) => info.address === host);
}

/** Refuse to install onto a port another process already holds. */
function requireFreePort(values: ServiceValues, deps: ServiceDeps): void {
  if (!isBindableHere(values.host, deps)) return;
  let listener: Deno.Listener;
  try {
    listener = Deno.listen({
      hostname: values.host === "localhost" ? "127.0.0.1" : values.host,
      port: values.port,
    });
  } catch (error) {
    if (isAddressInUseError(error)) {
      throw new ServiceDefinitionError(
        `ポート ${values.port} は既に使用中です (${values.host})。` +
          "使用中のプロセスを停止するか、--port で別のポートを指定してください。",
      );
    }
    throw error;
  }
  listener.close();
}

async function waitForHealth(
  values: ServiceValues,
  deps: ServiceDeps,
): Promise<boolean> {
  const url = `http://${localHost(values.host)}:${values.port}`;
  const deadline = Date.now() + deps.probeTimeoutMs;
  for (;;) {
    if (await deps.probe(url, values.token)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, deps.probeIntervalMs));
  }
}

/** Ask for lingering and report the state systemd actually holds (the request
 * itself fails where polkit reserves it for root, and the state is what
 * decides whether the machine starts the server at boot). */
async function ensureLinger(deps: ServiceDeps): Promise<boolean> {
  await deps.runner.loginctl(["enable-linger", deps.host.user]);
  return await isLingerEnabled(deps);
}

/** `service config`: the composed definition, without touching anything. */
async function runConfig(
  invocation: ServiceInvocation,
  deps: ServiceDeps,
): Promise<number> {
  requirePackaged(deps);
  const paths = servicePaths(deps.host);
  const installed = invocation.defaults
    ? {}
    : await readInstalledDocument(paths);
  const values = composeValues(
    invocation,
    deps,
    installed,
    () => DISPLAY_TOKEN,
  );

  deps.out("書き込む内容 (まだ何も変更していません):");
  deps.out("");
  deps.out(`${paths.unitPath}:`);
  deps.out(renderUnit(SERVICE_UNIT_TEMPLATE, paths));
  deps.out(`${paths.documentPath}:`);
  deps.out(documentForDisplay(renderDocument(values)).trimEnd());
  deps.out("");
  deps.out(
    "トークンは install 時に確定し、service.env にのみ書き込まれます" +
      " (表示では伏せています)。",
  );
  deps.out(
    "install を実行するまで、ユニットも service.env も作られません。" +
      " 内容は保存して systemd-analyze --user verify <file> で検証できます。",
  );
  return 0;
}

/** `service install`: write the definition and hand it to systemd. */
async function runInstall(
  invocation: ServiceInvocation,
  deps: ServiceDeps,
): Promise<number> {
  requireLinux(deps);
  requirePackaged(deps);
  requireNotDesktopManaged(deps);
  const paths = servicePaths(deps.host);

  await reloadSystemd(deps);
  await requireWritableInstallDir(paths);
  // The port is only ours to test when the unit is not already holding it:
  // a reinstall restarts the running server, which is what owns the port.
  const active = await isUnitActive(deps);
  const values = composeValues(
    invocation,
    deps,
    await readInstalledDocument(paths),
    deps.generateToken,
  );
  if (!active) requireFreePort(values, deps);

  await writeDocument(paths.documentPath, renderDocument(values));
  await Deno.mkdir(dirname(paths.unitPath), { recursive: true });
  await Deno.writeTextFile(
    paths.unitPath,
    renderUnit(SERVICE_UNIT_TEMPLATE, paths),
  );
  deps.out(`ユニット: ${paths.unitPath}`);
  deps.out(`設定:     ${paths.documentPath} (0600)`);
  await reloadSystemd(deps);
  expectOk(
    await deps.runner.systemctl(["enable", UNIT_NAME]),
    `systemctl --user enable ${UNIT_NAME}`,
  );
  deps.out("サービスを再起動します (実行中のセッションは中断されます)");
  expectOk(
    await deps.runner.systemctl(["restart", UNIT_NAME]),
    `systemctl --user restart ${UNIT_NAME}`,
  );

  const healthy = await waitForHealth(values, deps);
  deps.out(healthy ? "疎通確認: ok" : "疎通確認: 応答がありません");
  if (!healthy) {
    deps.err(
      `サーバーが応答しません (http://${
        localHost(values.host)
      }:${values.port})。` +
        `ログを確認してください: journalctl --user -u ${UNIT_NAME} -n 50`,
    );
  }

  const linger = await ensureLinger(deps);
  if (linger) {
    deps.out("自動起動: ok (ログインしていなくても起動します)");
  } else {
    deps.err(
      "自動起動: 未設定 — 次のコマンドを実行してください: " +
        `sudo loginctl enable-linger ${deps.host.user}`,
    );
    deps.err(
      "(linger が無効のままだと、ログインしていない状態では起動しません)",
    );
  }

  if (healthy) {
    deps.out("");
    deps.out("接続先:");
    for (
      const url of connectionUrls(values.host, values.port, deps.interfaces())
    ) {
      deps.out(`  ${tokenUrl(url, values.token)}`);
    }
    deps.out("  ※ この URL はトークンを含みます。共有しないでください。");
  }
  deps.out("");
  deps.out(`ログ:        journalctl --user -u ${UNIT_NAME} -f`);
  deps.out("状態:        lumisca-server service status");
  deps.out(`停止/再起動: systemctl --user stop|restart ${UNIT_NAME}`);
  return healthy && linger ? 0 : 1;
}

/** `service status`: what is installed, whether it drifted, and where it is. */
async function runStatus(deps: ServiceDeps): Promise<number> {
  requireLinux(deps);
  requirePackaged(deps);
  const paths = servicePaths(deps.host);
  const unitText = await readTextIfPresent(paths.unitPath);
  if (unitText === undefined) {
    deps.out(
      "未インストールです (lumisca-server service install で設置します)",
    );
    return 1;
  }
  const installed = await readInstalledDocument(paths);
  const drift = unitText !== renderUnit(SERVICE_UNIT_TEMPLATE, paths);
  const active = await isUnitActive(deps);
  const enabled = await isUnitEnabled(deps);
  const linger = await isLingerEnabled(deps);

  deps.out(`ユニット: ${paths.unitPath}`);
  deps.out(`設定:     ${paths.documentPath}`);
  deps.out(`稼働:     ${active ? "active" : "inactive"}`);
  deps.out(
    `自動起動: ${enabled ? "enabled" : "disabled"} / linger ${
      linger ? "有効" : "無効"
    }`,
  );
  if (drift) {
    deps.out(
      "ユニットが現在のサーバーバイナリの内容と一致しません。" +
        " lumisca-server service install で再インストールしてください。",
    );
  }
  if (!linger) {
    deps.out(
      `linger を有効にするには: sudo loginctl enable-linger ${deps.host.user}`,
    );
  }
  if (installed.token !== undefined) {
    const host = installed.host ?? DEFAULT_HOST;
    const port = installed.port ?? DEFAULT_PORT;
    deps.out("接続先:");
    for (const url of connectionUrls(host, port, deps.interfaces())) {
      deps.out(`  ${tokenUrl(url, installed.token)}`);
    }
    deps.out("  ※ この URL はトークンを含みます。共有しないでください。");
  } else {
    deps.out(
      "トークンが service.env にありません " +
        "(lumisca-server service install で設定します)",
    );
  }
  deps.out(`ログ: journalctl --user -u ${UNIT_NAME} -f`);
  return active && enabled && linger && !drift ? 0 : 1;
}

/** `service uninstall`: stop the unit and remove it, keeping the state that
 * belongs to the operator (the credential document and the database). */
async function runUninstall(deps: ServiceDeps): Promise<number> {
  requireLinux(deps);
  requirePackaged(deps);
  const paths = servicePaths(deps.host);
  if ((await readTextIfPresent(paths.unitPath)) === undefined) {
    deps.out("未インストールです (削除するユニットがありません)");
    return 1;
  }
  const installed = await readInstalledDocument(paths);

  expectOk(
    await deps.runner.systemctl(["disable", "--now", UNIT_NAME]),
    `systemctl --user disable --now ${UNIT_NAME}`,
  );
  await Deno.remove(paths.unitPath);
  await reloadSystemd(deps);

  deps.out(`ユニットを削除しました: ${paths.unitPath}`);
  deps.out(
    `設定は残しています: ${paths.documentPath}` +
      " (再インストール時にトークンを引き継ぎます)",
  );
  deps.out(
    `データベース: ${installed.db ?? join(paths.installDir, "lumisca.db")}`,
  );
  deps.out(
    "linger は変更していません。無効化するには: " +
      `loginctl disable-linger ${deps.host.user}`,
  );
  return 0;
}

/** Default health probe of the started server: the API answers only with the
 * credential, so the token travels with the request. */
async function probeHealth(url: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/health`, {
      headers: { "x-lumisca-token": token },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    // Not listening yet, or already gone: the caller is polling.
    return false;
  }
}
