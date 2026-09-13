/**
 * The service definition of one installation: the unit text and the values
 * behind it, composed from three ordered layers.
 *
 * ```
 * layer 1  systemd/template.ts                   the template shipped in the
 *                                                server binary
 * layer 2  <config home>/lumisca-agent/service.env   what a previous install
 *                                                wrote (and the operator may
 *                                                have edited)
 * layer 3  this invocation's flags               the most specific layer
 * ```
 *
 * Later layers win, and a layer only sets the values it carries — so
 * reinstalling without flags keeps the installed configuration, and
 * `service config` shows exactly what `service install` would write. The
 * order lives here and nowhere else: `config` and `install` compose through
 * the same function.
 *
 * Nothing in this module touches the system: it renders text and returns
 * values, which is what makes the whole decision surface unit-testable.
 */
import { isAbsolute, resolve } from "node:path";
import { isLoopbackHost } from "../routes/util.ts";
import {
  hasControlCharacter,
  ServiceDefinitionError,
  type ServiceLayer,
  type ServiceValues,
} from "./document.ts";
/** Files one installation's definition consists of. */
export interface ServicePaths {
  /** Unit file systemd loads. */
  unitPath: string;
  /** EnvironmentFile the unit points at (the layer-2 document). */
  documentPath: string;
  /** Directory the service runs in (the binary's own directory: a packaged
   * server resolves its database relative to the working directory). */
  installDir: string;
  /** HOME the unit sets. */
  home: string;
  /** Binary the unit starts. */
  execPath: string;
}

/** Values one invocation may set on the command line. `undefined` means
 * "not given" — the layer below applies. */
export type LaunchFlags = Omit<ServiceLayer, "xdgConfigHome">;

export interface ResolveOptions {
  /** Layer 2: what the installed document carries. */
  installed: ServiceLayer;
  /** Layer 3: this invocation's flags. */
  flags: LaunchFlags;
  /** XDG_CONFIG_HOME of the installing shell, or undefined. Pinned into the
   * document so the service reads the same settings file the operator has
   * (systemd's user environment usually has no XDG_CONFIG_HOME). */
  xdgConfigHome: string | undefined;
  /** Address and port when neither layer sets them. */
  defaults: { host: string; port: number };
  /** Directory a relative database path resolves against. */
  cwd: string;
  /** Injected so a first install's credential stays testable. */
  generateToken: () => string;
}

/** Placeholder syntax of the shipped unit template. */
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * Substitute `values` into a template, failing when the two disagree: a
 * placeholder without a value would ship a unit containing `{{execStart}}`,
 * and a value the template never uses means the template and this composer
 * have drifted apart. Both are bugs, not conditions to tolerate.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  const used = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new ServiceDefinitionError(
        `ユニットテンプレートのプレースホルダ ${name} に対応する値がありません`,
      );
    }
    used.add(name);
    return value;
  });
  const unused = Object.keys(values).filter((key) => !used.has(key));
  if (unused.length > 0) {
    throw new ServiceDefinitionError(
      `ユニットテンプレートが使わない値があります: ${unused.join(", ")}`,
    );
  }
  return rendered;
}

/**
 * Quote one *argument* value for a unit file: `ExecStart=` and
 * `Environment=NAME=`. `%` is doubled (systemd expands a single one as a
 * specifier) and the value is double-quoted with backslashes and quotes
 * escaped, so an installation path containing a space stays one argument.
 *
 * These two directives unquote their values (measured with
 * `systemd-analyze --user verify` on systemd 255: `ExecStart="/a b/bin"`
 * resolves to the command `/a b/bin`, and the unquoted spelling instead
 * splits at the space).
 */
export function quoteUnitValue(value: string): string {
  return `"${
    value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")
  }"`;
}

/**
 * Render one *path* value for a unit file: `WorkingDirectory=` and
 * `EnvironmentFile=`.
 *
 * Unquoted, unlike {@link quoteUnitValue}: systemd's path parsers do not
 * unquote their value (measured: the quoted spelling is rejected as "path is
 * not absolute" — the quote character is taken as part of the path, which
 * under `WorkingDirectory=` would be a fatal unit error). The whole rest of
 * the line is the value, so a space needs no quoting at all.
 *
 * A leading or trailing space is therefore unrepresentable (the parser strips
 * it, silently pointing the directive at a different path), so it is refused
 * instead of mis-installed.
 */
export function pathUnitValue(value: string): string {
  if (value !== value.trim()) {
    throw new ServiceDefinitionError(
      `前後に空白のあるパスはユニットファイルに表現できません: "${value}"`,
    );
  }
  return value.replace(/%/g, "%%");
}

/** Render the unit file for an installation. */
export function renderUnit(template: string, paths: ServicePaths): string {
  return renderTemplate(template, {
    execStart: quoteUnitValue(paths.execPath),
    workingDirectory: pathUnitValue(paths.installDir),
    home: quoteUnitValue(paths.home),
    environmentFile: pathUnitValue(paths.documentPath),
  });
}

/** Reject a value that would break the document or the unit: an empty
 * string, or a control character (a newline would split one value into a
 * malformed line). */
function assertText(field: string, value: string): string {
  if (value === "") {
    throw new ServiceDefinitionError(`${field} を空にできません`);
  }
  if (hasControlCharacter(value)) {
    throw new ServiceDefinitionError(`${field} に制御文字を含められません`);
  }
  return value;
}

/** A value that is matched verbatim against something the client sends (a
 * bind address, a Host-guard authority, a `?token=` value): whitespace is
 * never part of it, so a value containing one is a configuration error. */
function assertAtom(field: string, value: string): string {
  if (/\s/.test(assertText(field, value))) {
    throw new ServiceDefinitionError(`${field} に空白を含められません`);
  }
  return value;
}

/**
 * Compose the three layers into the values this installation runs with.
 *
 * The one cross-layer rule is here rather than in the caller: exposing the
 * server beyond loopback requires naming the authorities clients will use
 * (`LUMISCA_ALLOWED_HOSTS`), because the Host guard rejects any hostname it
 * was not told about — a missing list would otherwise surface as a 403 in a
 * remote browser with nothing in the install output to explain it.
 */
export function resolveValues(options: ResolveOptions): ServiceValues {
  const host = assertAtom(
    "LUMISCA_HOST",
    options.flags.host ?? options.installed.host ?? options.defaults.host,
  );
  const port = options.flags.port ?? options.installed.port ??
    options.defaults.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServiceDefinitionError(
      `LUMISCA_PORT が不正です: "${port}" (1〜65535 の整数を指定してください)`,
    );
  }
  const dbValue = options.flags.db ?? options.installed.db;
  const db = dbValue === undefined ? undefined : assertText(
    "LUMISCA_DB",
    isAbsolute(dbValue) ? dbValue : resolve(options.cwd, dbValue),
  );
  const allowedHosts = (
    options.flags.allowedHosts ?? options.installed.allowedHosts ?? []
  ).map((entry) => assertAtom("LUMISCA_ALLOWED_HOSTS", entry));
  if (!isLoopbackHost(host) && allowedHosts.length === 0) {
    throw new ServiceDefinitionError(
      `ループバック以外 (${host}) で待ち受けるには --allowed-hosts が必要です ` +
        "(クライアントが使うホスト名/IP をカンマ区切りで指定してください。" +
        "例: --allowed-hosts 100.64.0.5,homeserver,homeserver.local)",
    );
  }
  const token = assertAtom(
    "LUMISCA_TOKEN",
    options.flags.token ?? options.installed.token ?? options.generateToken(),
  );
  const xdgConfigHome = options.xdgConfigHome ??
    options.installed.xdgConfigHome;
  return {
    host,
    port,
    db,
    allowedHosts,
    token,
    xdgConfigHome: xdgConfigHome === undefined
      ? undefined
      : assertText("XDG_CONFIG_HOME", xdgConfigHome),
  };
}
