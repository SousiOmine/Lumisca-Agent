/**
 * `lumisca-server service uninstall`: stop the unit, remove it, and keep the
 * state that belongs to the operator.
 *
 * The document is the credential and the database is the data: both survive,
 * so a later install leaves already-installed clients working and the server
 * keeps its history. linger is left alone for the same reason — it is a login
 * setting, not a property of this unit — and the operator is told how to turn
 * it off.
 */
import { join } from "node:path";
import type { ServiceDeps } from "./deps.ts";
import { servicePaths, UNIT_NAME } from "./plan.ts";
import {
  expectOk,
  readInstalledDocument,
  readTextIfPresent,
  reloadSystemd,
  requireLinux,
  requirePackaged,
} from "./shared.ts";

/** `service uninstall`: stop the unit and remove it, keeping the state that
 * belongs to the operator (the credential document and the database). */
export async function runUninstall(deps: ServiceDeps): Promise<number> {
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
