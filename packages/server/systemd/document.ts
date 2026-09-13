/**
 * The EnvironmentFile of a service installation: the document
 * `lumisca-server service install` writes and the file the unit's
 * `EnvironmentFile=` points at.
 *
 * It is the second of the three composition layers (see compose.ts) and the
 * only place a credential lives. Two rules follow from that:
 *
 * - The file is written 0600 and never echoed: `service config` prints it
 *   through {@link documentForDisplay}, and no other code path prints the
 *   token (the install summary points at the file instead).
 * - The operator owns this layer. Values it carries are read back and
 *   re-composed on the next install, so a hand-edited value survives an
 *   install (and deleting a line is how a previously installed value is
 *   unset again).
 *
 * The format is systemd's EnvironmentFile grammar restricted to what this
 * feature needs: `KEY=value`, `#`/`;` comment lines, and double or single
 * quoted values. Line continuations and escapes beyond `\\` and `\"` are
 * rejected instead of mis-parsed — a document this server cannot read
 * exactly is a configuration error, not something to guess about.
 */

/** Restart mode the unit requires: the server exits after applying an update
 * and systemd's `Restart=always` starts the new binary (see
 * update/service.ts). Another value would contradict the unit, so a document
 * that carries one is rejected. */
export const SERVICE_RESTART_MODE = "supervisor";

/** The environment keys a service document may carry. Each one is a launcher
 * key the server reads (`startup.SERVER_STARTUP_ENV_KEYS`) plus
 * `XDG_CONFIG_HOME`, which pins the settings file to the one the installing
 * user has. An unknown key is a typo'd configuration, not a value to ignore:
 * `LUMISCA_ALLOWED_HOST` would silently leave remote clients with 403. */
export const DOCUMENT_KEYS = [
  "LUMISCA_HOST",
  "LUMISCA_PORT",
  "LUMISCA_DB",
  "LUMISCA_ALLOWED_HOSTS",
  "LUMISCA_TOKEN",
  "LUMISCA_UPDATE_RESTART",
  "XDG_CONFIG_HOME",
] as const;

/** Token value the composed document carries while it is only *displayed*
 * (`service config`). The real credential is settled by `install` and never
 * echoed; display replaces the value with {@link REDACTED_TOKEN}. */
export const DISPLAY_TOKEN = "not-installed";

/** What `service config` prints instead of the credential. */
export const REDACTED_TOKEN = "<伏せ字>";

/** Values one installation's service definition carries. */
export interface ServiceValues {
  /** Address the unit's server binds. */
  host: string;
  /** Port the unit's server binds. */
  port: number;
  /** Absolute database path, or undefined for the application's own default
   * (`<WorkingDirectory>/lumisca.db`). */
  db: string | undefined;
  /** Authorities the Host guard accepts besides loopback hostnames. */
  allowedHosts: string[];
  /** Credential clients must present. */
  token: string;
  /** XDG_CONFIG_HOME to pin, or undefined to let the service use
   * `<home>/.config` like the installing shell did. */
  xdgConfigHome: string | undefined;
}

/** One layer of the composition: the values it sets, `undefined` leaving a
 * value to the layer below. Used for both an installed document (layer 2)
 * and this invocation's flags (layer 3). */
export type ServiceLayer = Partial<ServiceValues>;

/** A service definition that cannot be trusted to install. */
export class ServiceDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceDefinitionError";
  }
}

/**
 * Whether a value carries a control character. A newline would split one
 * value into two lines of the document (or two arguments of a unit
 * directive), so a document value is never allowed to contain one.
 *
 * A character loop rather than a regular expression: an escape range for
 * control characters is exactly what the lint rule `no-control-regex` guards
 * against, and the intent is clearer this way.
 */
export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Parse one document value. Quotes are systemd's: inside `"` the escapes
 * `\\` and `\"` are processed, inside `'` nothing is. */
function parseValue(raw: string, line: number): string {
  const text = raw.trim();
  if (text === "") return "";
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return text;
  if (text.length < 2 || !text.endsWith(quote)) {
    throw new ServiceDefinitionError(
      `service.env の ${line} 行目: 引用符が閉じていません`,
    );
  }
  const inner = text.slice(1, -1);
  if (quote === "'") {
    if (inner.includes("'")) {
      throw new ServiceDefinitionError(
        `service.env の ${line} 行目: 引用符の中に引用符があります`,
      );
    }
    return inner;
  }
  return inner.replace(/\\(.)/g, (_match, escaped: string) => {
    if (escaped === "\\") return "\\";
    if (escaped === '"') return '"';
    throw new ServiceDefinitionError(
      `service.env の ${line} 行目: 対応していないエスケープ \\${escaped} です`,
    );
  });
}

/**
 * Read an installed document. Returns the values it sets (absent keys stay
 * undefined, so the defaults apply). Throws {@link ServiceDefinitionError}
 * for a line this server cannot read exactly, naming the offending key or
 * line number.
 */
export function parseDocument(text: string): ServiceLayer {
  const values: ServiceLayer = {};
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    const number = index + 1;
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new ServiceDefinitionError(
        `service.env の ${number} 行目: KEY=value の形式ではありません`,
      );
    }
    const key = line.slice(0, separator).trim();
    const value = parseValue(line.slice(separator + 1), number);
    switch (key) {
      case "LUMISCA_HOST":
        values.host = value;
        break;
      case "LUMISCA_PORT":
        values.port = parseDocumentPort(value, number);
        break;
      case "LUMISCA_DB":
        values.db = value;
        break;
      case "LUMISCA_ALLOWED_HOSTS":
        values.allowedHosts = splitHosts(value);
        break;
      case "LUMISCA_TOKEN":
        if (value === "") {
          throw new ServiceDefinitionError(
            `service.env の ${number} 行目: LUMISCA_TOKEN が空です`,
          );
        }
        values.token = value;
        break;
      case "LUMISCA_UPDATE_RESTART":
        if (value !== SERVICE_RESTART_MODE) {
          throw new ServiceDefinitionError(
            `service.env の ${number} 行目: LUMISCA_UPDATE_RESTART は ` +
              `"${SERVICE_RESTART_MODE}" のみ有効です ("${value}")`,
          );
        }
        break;
      case "XDG_CONFIG_HOME":
        values.xdgConfigHome = value;
        break;
      default:
        throw new ServiceDefinitionError(
          `service.env の ${number} 行目: 未知のキー "${key}" です ` +
            `(使用できるのは ${DOCUMENT_KEYS.join(", ")})`,
        );
    }
  }
  return values;
}

/** Port from a document. Parsed here (not by startup.parseServerPort) so a
 * malformed value names its line instead of a launcher key. */
function parseDocumentPort(value: string, line: number): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServiceDefinitionError(
      `service.env の ${line} 行目: LUMISCA_PORT が不正です: "${value}"`,
    );
  }
  return port;
}

/** Split a `LUMISCA_ALLOWED_HOSTS` value the way the server does
 * (comma-separated, trimmed, case-folded, empties dropped). */
export function splitHosts(value: string): string[] {
  const hosts: string[] = [];
  for (const entry of value.split(",")) {
    const host = entry.trim().toLowerCase();
    if (host !== "" && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/** Quote one document value. `\` and `"` are escaped so any path, hostname,
 * or token round-trips through {@link parseDocument}. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render a document. Keys are written in a fixed order and every value is
 * quoted, so the same values always produce the same text (an install that
 * changes nothing rewrites the identical file).
 */
export function renderDocument(values: ServiceValues): string {
  const lines = [
    `LUMISCA_HOST=${quote(values.host)}`,
    `LUMISCA_PORT=${quote(String(values.port))}`,
  ];
  if (values.db !== undefined) lines.push(`LUMISCA_DB=${quote(values.db)}`);
  if (values.allowedHosts.length > 0) {
    lines.push(`LUMISCA_ALLOWED_HOSTS=${quote(values.allowedHosts.join(","))}`);
  }
  lines.push(
    `LUMISCA_TOKEN=${quote(values.token)}`,
    `LUMISCA_UPDATE_RESTART=${quote(SERVICE_RESTART_MODE)}`,
  );
  if (values.xdgConfigHome !== undefined) {
    lines.push(`XDG_CONFIG_HOME=${quote(values.xdgConfigHome)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The document as `service config` may print it: the credential replaced
 * with {@link REDACTED_TOKEN}. Only ever used for display. */
export function documentForDisplay(text: string): string {
  return text.replace(
    /^LUMISCA_TOKEN=.*$/m,
    `LUMISCA_TOKEN=${REDACTED_TOKEN}`,
  );
}

/** A fresh credential for a first install: 32 random bytes, hex. */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
