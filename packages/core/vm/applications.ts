/**
 * Starting a program on the machine's screen.
 *
 * The machine has a display but no desktop menu: a window manager (openbox)
 * draws frames and nothing more, so a program the agent wants to use has to be
 * started from a shell with `DISPLAY` set — and the agent has no way to know
 * what is even installed. Both halves are one tool: `vm_launch` lists the
 * programs (`action: "list"`) and starts one (`action: "start"`), because an
 * agent that can only start would invent names, and one that can only list
 * would still not know how to run anything.
 *
 * The list comes from the freedesktop entries the image installs
 * (`/usr/share/applications/*.desktop`): the same file a real desktop menu
 * reads, so "installed" means the same thing here as it does to a person
 * sitting at that machine. Entries that cannot be started headlessly
 * (`NoDisplay`, `Terminal=true` with no emulator, a missing `Exec`) are left
 * out rather than offered and then failing.
 */

/** One program the machine can start. */
export interface VmApplication {
  /** The `.desktop` file's base name without the extension: the id
   * `vm_launch` takes back. */
  id: string;
  /** The name a person would use (`Name`), and the generic one when the
   * entry has it (`GenericName`). */
  name: string;
  /** The command line the entry declares, with field codes removed. */
  exec: string;
  /** What the program is for, when the entry says (`Comment`). */
  comment?: string;
}

/** Directories the freedesktop specification puts entries in, in the order a
 * desktop reads them (the earlier one wins on an id clash). */
export const APPLICATION_DIRS = [
  "/usr/share/applications",
  "/usr/local/share/applications",
  "/home/agent/.local/share/applications",
] as const;

/** Field codes of a `Exec` value (`%f`, `%U`, `%i` …). They stand for a file
 * or a URL a desktop hands the program; started from a shell there is
 * nothing to hand over, so they are removed rather than passed literally. */
const FIELD_CODES = /%[fFuUdDnNickvm]/g;

/** The groups of an ini file, keyed by group name, in file order.
 *
 * A `.desktop` file is an ini file; this reads exactly what the freedesktop
 * specification defines (a `[Group]` line, then `Key=Value` lines, with `#`
 * starting a comment). Values may carry `\\` escapes and localized keys
 * (`Name[ja]=…`); both are kept as the file wrote them, and the caller picks
 * the keys it understands.
 */
function parseIniGroups(text: string): Map<string, Map<string, string>> {
  const groups = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1);
      current = groups.get(name) ?? new Map<string, string>();
      groups.set(name, current);
      continue;
    }
    const at = line.indexOf("=");
    if (at === -1 || current === undefined) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    // The first occurrence wins: a duplicate key is malformed, and a desktop
    // reads the first one.
    if (!current.has(key)) current.set(key, value);
  }
  return groups;
}

/** Parse one `.desktop` file into a launchable application, or undefined when
 * it is not one this machine can start.
 *
 * A `.desktop` file is an ini file with a `[Desktop Entry]` group. The keys
 * that decide whether a desktop would show it (`NoDisplay`, `Hidden`,
 * `Type`) are honoured: offering an entry a desktop hides would make the list
 * disagree with the machine.
 */
export function applicationFromDesktopFile(
  fileName: string,
  text: string,
): VmApplication | undefined {
  if (!fileName.endsWith(".desktop")) return undefined;
  const groups = parseIniGroups(text);
  const entry = groups.get("Desktop Entry");
  if (entry === undefined) return undefined;
  const type = entry.get("Type");
  // `Application` is the kind that is startable; a Link or a Directory entry
  // is a shortcut for a file manager that this machine does not have.
  if (type !== undefined && type !== "Application") return undefined;
  if (entry.has("NoDisplay") || entry.has("Hidden")) return undefined;
  const name = entry.get("Name")?.trim();
  if (name === undefined || name === "") return undefined;
  const rawExec = entry.get("Exec");
  if (rawExec === undefined) return undefined;
  // `%i` expands to `--icon <name>`; dropping the code alone would leave the
  // flag with no argument, so the pair goes together.
  const exec = rawExec
    .replace(/%i/g, "")
    .replace(FIELD_CODES, "")
    .replace(/\s+/g, " ")
    .trim();
  if (exec === "") return undefined;
  const comment = entry.get("Comment")?.trim();
  return {
    id: fileName.slice(0, -".desktop".length),
    name,
    exec,
    ...(comment === undefined || comment === "" ? {} : { comment }),
  };
}

/** Sort a list of applications the way a menu does: by the name a person
 * reads, case-insensitively, so the agent's scan matches a human's. */
export function sortApplications(
  applications: readonly VmApplication[],
): VmApplication[] {
  return [...applications].sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
    a.id.localeCompare(b.id)
  );
}

/** The sentence that lists what the machine has, grouped one per line. */
export function describeApplications(
  applications: readonly VmApplication[],
): string {
  if (applications.length === 0) {
    return "No programs are installed that can be started on the screen.";
  }
  return [
    `${applications.length} program(s) can be started on the screen:`,
    ...applications.map((app) =>
      `- ${app.name} (\`${app.id}\`)` +
      `${app.comment === undefined ? "" : ` — ${app.comment}`}`
    ),
  ].join("\n");
}
