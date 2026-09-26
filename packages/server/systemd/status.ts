/**
 * `lumisca-server service status`: what is installed, whether it drifted from
 * the binary running this command, and where clients reach it.
 *
 * The state it reads is systemd's, not a record of what `install` did, so the
 * exit code answers "would a restart leave this installation as it is":
 * active, enabled, lingering, and the unit file identical to what the current
 * template renders. A unit another version wrote is therefore reported
 * instead of a healthy installation.
 */
import { DEFAULT_HOST, DEFAULT_PORT } from "../startup.ts";
import { renderUnit } from "./compose.ts";
import type { ServiceDeps } from "./deps.ts";
import { servicePaths, UNIT_NAME } from "./plan.ts";
import {
  isLingerEnabled,
  isUnitActive,
  isUnitEnabled,
  printConnectionTargets,
  readInstalledDocument,
  readTextIfPresent,
  requireLinux,
  requirePackaged,
} from "./shared.ts";
import { SERVICE_UNIT_TEMPLATE } from "./template.ts";

/** `service status`: what is installed, whether it drifted, and where it is. */
export async function runStatus(deps: ServiceDeps): Promise<number> {
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
    printConnectionTargets(
      installed.host ?? DEFAULT_HOST,
      installed.port ?? DEFAULT_PORT,
      installed.token,
      deps,
    );
  } else {
    deps.out(
      "トークンが service.env にありません " +
        "(lumisca-server service install で設定します)",
    );
  }
  deps.out(`ログ: journalctl --user -u ${UNIT_NAME} -f`);
  return active && enabled && linger && !drift ? 0 : 1;
}
