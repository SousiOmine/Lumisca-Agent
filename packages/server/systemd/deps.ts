/**
 * What the `service` verbs need from the outside world, and the real machine
 * behind it.
 *
 * The verbs decide, this module supplies: the host facts (OS, packaged
 * binary, the layout under HOME), systemd itself (runner.ts), the network,
 * and the console all arrive as {@link ServiceDeps}, which is what makes the
 * whole command testable without a Linux host, a packaged binary, or a user
 * manager. `defaultServiceDeps` is the only place that reads the environment
 * to build it.
 *
 * The environment can fail to answer (no HOME, no user name). That is raised
 * as a usage error from here, and it is resolved *inside* the command's error
 * mapping (see mod.ts): a rejection raised before it would reach the
 * launcher's unhandled-rejection handler, print, and let the process drain
 * its event loop into a silent exit 0.
 */
import { DESKTOP_ENV_KEY, isDesktopManaged } from "../startup.ts";
import { generateToken } from "./document.ts";
import { type ServiceHost, ServiceUsageError } from "./plan.ts";
import { createSystemdRunner, type ServiceRunner } from "./runner.ts";

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

/** Default health probe of the started server: the API answers only with the
 * credential, so the token travels with the request. It lives here rather
 * than with `install`'s other checks because the default deps are the only
 * caller (`install` asks through `deps.probe`), and reaching back into the
 * verb would be a cycle. */
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
