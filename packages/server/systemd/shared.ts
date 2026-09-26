/**
 * What every `service` verb shares: the preconditions they refuse on, the
 * systemd and file operations they run, and the two halves of the answer they
 * print — the unit's state, and where a client connects.
 *
 * The verbs (config.ts, install.ts, status.ts, uninstall.ts) depend on this
 * module, and this module depends only on `ServiceDeps` and the modules below
 * it, so no verb has to know another. The unit-state queries and the
 * connection display live here rather than in status.ts because `install`
 * asks the same questions: whether the running unit already owns the port it
 * is about to bind, whether linger is on, and where the operator can reach
 * the server it just started.
 */
import { hostForUrl } from "@lumisca/core/shared";
import { DEFAULT_HOST, DEFAULT_PORT, DESKTOP_ENV_KEY } from "../startup.ts";
import { resolveValues, type ServicePaths } from "./compose.ts";
import type { ServiceDeps } from "./deps.ts";
import {
  parseDocument,
  type ServiceLayer,
  type ServiceValues,
} from "./document.ts";
import {
  type ServiceInvocation,
  ServiceUsageError,
  UNIT_NAME,
} from "./plan.ts";
import { type CommandResult, ServiceCommandError } from "./runner.ts";

/** A packaged server owns its installation: a `deno run` server would put the
 * runtime's own path into the unit, and the desktop shell's copy is replaced
 * by the app's updater. */
export function requirePackaged(deps: ServiceDeps): void {
  if (!deps.host.standalone) {
    throw new ServiceUsageError(
      "常駐化はパッケージ済みサーバーでのみ実行できます " +
        "(開発実行: deno run packages/server/mod.ts)",
    );
  }
}

/** A user unit needs systemd and a Linux home layout. */
export function requireLinux(deps: ServiceDeps): void {
  if (deps.host.os !== "linux") {
    throw new ServiceUsageError(
      `systemd による常駐は Linux のみ対応です (現在: ${deps.host.os})`,
    );
  }
}

export function requireNotDesktopManaged(deps: ServiceDeps): void {
  if (deps.host.desktopManaged) {
    throw new ServiceUsageError(
      "デスクトップアプリが起動するサーバーは常駐化できません " +
        `(${DESKTOP_ENV_KEY} が設定されています)`,
    );
  }
}

/** Fail fast on a systemd command that did not succeed: its stderr is the
 * operator's only explanation, so it is never swallowed. */
export function expectOk(result: CommandResult, what: string): void {
  if (result.code === 0) return;
  const detail = result.stderr === "" ? result.stdout : result.stderr;
  throw new ServiceCommandError(
    `${what} に失敗しました (終了コード ${result.code}): ${detail}`,
  );
}

/** `systemctl --user daemon-reload` doubles as the reachability check for the
 * user bus: it is a no-op that fails loudly when systemd (or the connection
 * to the user manager) is missing, before anything is written. */
export async function reloadSystemd(deps: ServiceDeps): Promise<void> {
  expectOk(
    await deps.runner.systemctl(["daemon-reload"]),
    "systemctl --user daemon-reload",
  );
}

export async function readTextIfPresent(
  path: string,
): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/** The layer-2 document, or an empty layer when nothing is installed yet. */
export async function readInstalledDocument(
  paths: ServicePaths,
): Promise<ServiceLayer> {
  const text = await readTextIfPresent(paths.documentPath);
  return text === undefined ? {} : parseDocument(text);
}

/** Compose the three layers for an invocation. `generateToken` differs by
 * verb: `install` settles a real credential, `config` only displays. */
export function composeValues(
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

/** Whether the unit is running right now. */
export async function isUnitActive(deps: ServiceDeps): Promise<boolean> {
  const result = await deps.runner.systemctl(["is-active", UNIT_NAME]);
  return result.stdout === "active";
}

/** Whether the unit is enabled (started with the user manager). */
export async function isUnitEnabled(deps: ServiceDeps): Promise<boolean> {
  const result = await deps.runner.systemctl(["is-enabled", UNIT_NAME]);
  return result.stdout === "enabled";
}

/** Whether lingering is on: without it the unit starts at login, not at
 * boot. */
export async function isLingerEnabled(deps: ServiceDeps): Promise<boolean> {
  const result = await deps.runner.loginctl([
    "show-user",
    deps.host.user,
    "-p",
    "Linger",
  ]);
  return result.code === 0 && result.stdout.includes("Linger=yes");
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
    hosts.push(hostForUrl(host));
  }
  return hosts.map((entry) => `http://${entry}:${port}/`);
}

/** A URL that carries the credential, as the operator needs it to open the
 * UI from another device. */
function tokenUrl(base: string, token: string): string {
  return `${base}?token=${encodeURIComponent(token)}`;
}

/** Where clients reach the server, with the two things the operator needs
 * to know about such a URL: it carries the credential (so it must not be
 * shared), and pasting it is a one-time act — the browser stores the token
 * as a cookie (packages/server/auth-cookie.ts), so later visits need only
 * the plain address. */
export function printConnectionTargets(
  host: string,
  port: number,
  token: string,
  deps: ServiceDeps,
): void {
  deps.out("接続先:");
  for (const url of connectionUrls(host, port, deps.interfaces())) {
    deps.out(`  ${tokenUrl(url, token)}`);
  }
  deps.out("  ※ この URL はトークンを含みます。共有しないでください。");
  deps.out(
    "  ※ ブラウザで一度開くとトークンが Cookie に保存され、" +
      "以降はトークン無しの URL でも開けます。",
  );
}
