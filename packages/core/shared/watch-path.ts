/**
 * The field path a `watch` reads out of an MCP tool's result.
 *
 * A watch has to answer "did anything new appear?" from a tool's JSON,
 * without an inference call. The answer lives in one field of the result
 * (`data.messages[].id`), so the source names that field and the check
 * extracts it.
 *
 * The accepted shape is only what that needs: field names joined by dots,
 * with `[]` after a name that is an array to map over. A JSONPath engine
 * would accept far more than a watch can use, and every filter, slice and
 * descendant selector would be a rule the settings list cannot show the
 * user.
 */

/** Most ids a check keeps. The comparison is "is there an id I have not
 * seen", so the window has to survive the interval between checks; a hundred
 * covers a busy mailbox at the five-minute floor, and the stored state stays
 * a few kilobytes on the routine's row. */
export const MAX_WATCH_IDS = 100;

/** One field name, without its `[]` marker. */
const FIELD = /^[A-Za-z0-9_-]+$/;

/** Why `path` is not one a watch can follow, or null. The message goes to
 * the model (it wrote the path), so it shows the accepted shape. */
export function watchPathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path.trim() === "") {
    return 'a field path such as "data.messages[].id"';
  }
  for (const segment of path.split(".")) {
    const name = segment.endsWith("[]") ? segment.slice(0, -2) : segment;
    if (!FIELD.test(name)) {
      return `"${segment}" is not a field name (letters, digits, "_" and ` +
        '"-", with "[]" after a name whose value is an array to map over)';
    }
  }
  return null;
}

/**
 * The value `path` names in `root`, or undefined when it names nothing.
 *
 * A segment with `[]` maps over the array it names and applies the rest of
 * the path to each item, so `data.messages[].id` answers the ids of every
 * message rather than the `[]` segment's own value.
 */
export function resolveWatchPath(root: unknown, path: string): unknown {
  return resolve(root, path.split("."));
}

function resolve(value: unknown, segments: string[]): unknown {
  const [segment, ...rest] = segments;
  if (segment === undefined) return value;
  const iterate = segment.endsWith("[]");
  const field = read(value, iterate ? segment.slice(0, -2) : segment);
  if (!iterate) return resolve(field, rest);
  if (!Array.isArray(field)) return undefined;
  return field.map((item) => resolve(item, rest));
}

function read(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[name];
}

/**
 * The identity values `path` yields, in order, at most {@link MAX_WATCH_IDS}.
 *
 * `undefined` means the path does not name a list of ids (a missing field, a
 * string where a list belongs, a null in the middle). That is a broken
 * watch, not an empty one: reporting "nothing new" for it would leave the
 * routine looking healthy while it never fires. An empty list is a real
 * observation — the list is simply empty.
 *
 * Strings and numbers only: an id is the thing the user can point at, and
 * anything else (a nested object) means the path stopped at the wrong
 * level.
 */
export function watchIdsFrom(
  root: unknown,
  path: string,
): string[] | undefined {
  const resolved = resolveWatchPath(root, path);
  if (!Array.isArray(resolved)) return undefined;
  const ids: string[] = [];
  for (const item of resolved) {
    if (typeof item !== "string" && typeof item !== "number") {
      return undefined;
    }
    ids.push(String(item));
    if (ids.length === MAX_WATCH_IDS) break;
  }
  return ids;
}
