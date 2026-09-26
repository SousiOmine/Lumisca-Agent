/**
 * `lumisca-server service install`: write the definition and hand it to
 * systemd.
 *
 * Every precondition is checked before anything is written, because the
 * alternative is a restart loop under systemd's `Restart=always` with the
 * reason buried in the journal. What cannot be decided beforehand is decided
 * by doing it: whether the install directory is writable by creating the
 * staging area the updater will use, whether the server came up by asking its
 * health route. The checks and the wait belong to this verb alone — `install`
 * is the one command that touches the system (see mod.ts).
 */
import { dirname, join } from "node:path";
import { hostForUrl, isLoopbackHost } from "@lumisca/core/shared";
import { isAddressInUseError } from "../startup.ts";
import { STAGING_DIR_NAME } from "../update/stage.ts";
import { renderUnit, type ServicePaths } from "./compose.ts";
import type { ServiceDeps } from "./deps.ts";
import {
  renderDocument,
  ServiceDefinitionError,
  type ServiceValues,
} from "./document.ts";
import { type ServiceInvocation, servicePaths, UNIT_NAME } from "./plan.ts";
import {
  composeValues,
  expectOk,
  isLingerEnabled,
  isUnitActive,
  printConnectionTargets,
  readInstalledDocument,
  reloadSystemd,
  requireLinux,
  requireNotDesktopManaged,
  requirePackaged,
} from "./shared.ts";
import { SERVICE_UNIT_TEMPLATE } from "./template.ts";

/** File the write-access check creates inside the updater's staging
 * directory. */
const WRITE_PROBE_NAME = ".write-test";

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

/** Whether binding `host` here can be tested at all: an address this machine
 * does not own fails for a different reason, and reporting that as a port
 * conflict would be misleading. */
function isBindableHere(host: string, deps: ServiceDeps): boolean {
  if (isLoopbackHost(host)) return true;
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
  const url = `http://${hostForUrl(values.host)}:${values.port}`;
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

/** `service install`: write the definition and hand it to systemd. */
export async function runInstall(
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
        hostForUrl(values.host)
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
    printConnectionTargets(values.host, values.port, values.token, deps);
  }
  deps.out("");
  deps.out(`ログ:        journalctl --user -u ${UNIT_NAME} -f`);
  deps.out("状態:        lumisca-server service status");
  deps.out(`停止/再起動: systemctl --user stop|restart ${UNIT_NAME}`);
  return healthy && linger ? 0 : 1;
}
