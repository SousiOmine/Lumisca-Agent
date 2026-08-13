import { join, relative } from "node:path";
import { isWithin } from "../workspace/path-util.ts";

/** Convert a glob pattern to a RegExp. Supports `**`, `*`, `?`, `{a,b}`.
 * A double-star segment matches zero or more directories, so a pattern like
 * `a` + `**` + slash + `b.ts` also matches `a/b.ts`. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
    } else if (c === "*") {
      out += "[^/]*";
      i += 1;
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        const alts = glob
          .slice(i + 1, end)
          .split(",")
          .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|");
        out += `(?:${alts})`;
        i = end + 1;
      } else {
        out += "\\{";
        i += 1;
      }
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** One parsed .gitignore rule. */
interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  basenameOnly: boolean;
  re: RegExp;
}

/**
 * Minimal .gitignore matcher, loaded from each workspace root's own
 * `.gitignore` (nested .gitignore files are not consulted). Supports the
 * common git semantics: `#` comments, `!` negation, a trailing `/` limiting
 * a rule to directories, a pattern without `/` matching the basename at any
 * depth, and `*` / `?` / `**` globbing (plus `{a,b}`, a harmless superset
 * of git's pattern language). The last matching rule wins.
 */
export class GitignoreMatcher {
  private constructor(
    private readonly rulesByRoot: Map<string, IgnoreRule[]>,
  ) {}

  /** Load `.gitignore` from each root; roots without one get no rules.
   * Keys are canonicalized (realpath) so they compare equal to the
   * resolved walk roots of the tools. */
  static async load(roots: string[]): Promise<GitignoreMatcher> {
    const rulesByRoot = new Map<string, IgnoreRule[]>();
    for (const root of roots) {
      try {
        const canonical = await Deno.realPath(root);
        const text = await Deno.readTextFile(join(canonical, ".gitignore"));
        rulesByRoot.set(canonical, parseGitignore(text));
      } catch {
        // No .gitignore in this root (or the root no longer exists).
      }
    }
    return new GitignoreMatcher(rulesByRoot);
  }

  /** True when `relPath` (relative to `walkRoot`) is ignored. `walkRoot`
   * may be a workspace root or any directory inside it (the tools pass the
   * resolved `path` argument) — the owning root's rules are found by
   * containment and the path is re-based onto that root, so anchored
   * patterns match correctly for subdirectory walks. `isDir` matters for
   * directory-only rules; an ignored directory means everything below it
   * is ignored (the walker prunes it). */
  ignores(walkRoot: string, relPath: string, isDir: boolean): boolean {
    for (const [root, rules] of this.rulesByRoot) {
      if (!isWithin(root, walkRoot)) continue;
      // Rules are root-relative; re-base the walk-relative path.
      const rootRelative = relative(root, join(walkRoot, relPath))
        .replace(/\\/g, "/");
      return applyRules(rules, rootRelative, isDir);
    }
    return false;
  }
}

function applyRules(
  rules: IgnoreRule[],
  relPath: string,
  isDir: boolean,
): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const matched = rule.basenameOnly
      ? rule.re.test(basename)
      : rule.re.test(normalized);
    if (!matched) continue;
    ignored = !rule.negated;
  }
  return ignored;
}

function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // Trailing spaces are ignored (git semantics).
    const line = raw.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    } else if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
      pattern = pattern.slice(1);
    }
    if (pattern === "") continue;
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    if (pattern === "") continue;
    const basenameOnly = !pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    rules.push({ negated, dirOnly, basenameOnly, re: globToRegExp(pattern) });
  }
  return rules;
}
