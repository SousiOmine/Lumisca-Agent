/**
 * `lumisca-server service config`: the definition this installation would
 * write, printed and nothing else.
 *
 * It is the composition `install` performs (compose.ts owns the order) with
 * the credential replaced for display, so what the operator reads here is
 * what an install would produce — including the installed layer it would
 * keep. `--defaults` is the one case that ignores that layer, showing the
 * shipped template alone. Nothing in this file touches the system: no systemd
 * call, no file written.
 */
import { renderUnit } from "./compose.ts";
import type { ServiceDeps } from "./deps.ts";
import {
  DISPLAY_TOKEN,
  documentForDisplay,
  renderDocument,
} from "./document.ts";
import { type ServiceInvocation, servicePaths } from "./plan.ts";
import {
  composeValues,
  readInstalledDocument,
  requirePackaged,
} from "./shared.ts";
import { SERVICE_UNIT_TEMPLATE } from "./template.ts";

/** `service config`: the composed definition, without touching anything. */
export async function runConfig(
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
