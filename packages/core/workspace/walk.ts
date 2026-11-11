import { join, relative } from "node:path";
import { type DirEntry, runtime } from "../runtime/runtime.ts";
import { isWithin } from "./path-util.ts";

/** VCS metadata and build-output directories always pruned by the workspace
 * walk, at any depth. `node_modules` is deliberately absent: the listing
 * excludes it on its own (workspace/files.ts), because a dependency tree is
 * a project's contents even when the user has not gitignored it. */
export const BUILD_ARTIFACT_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".lumisca-cache",
  // Tool output this application itself spills (tools/truncate.ts): it is
  // scratch space for one truncated result, never part of the user's tree.
  ".lumisca-tool-output",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "target",
  "bin",
  "obj",
]);

/** One visited entry of a walk. `rel` is the path relative to the walk
 * root (posix separators). */
export interface WalkEntry {
  path: string;
  rel: string;
  isDir: boolean;
}

export interface WalkOptions {
  /** Skip `.`-prefixed entries (default true). */
  skipHidden?: boolean;
  /** Directory names always pruned at any depth (e.g. node_modules). */
  excludedDirs?: ReadonlySet<string>;
  /** Ignored directories are pruned and ignored files are skipped (a
   * matcher loaded from the workspace roots). */
  gitignore?: GitignoreMatcher;
  /** Maximum recursion depth (default 32; the root is depth 0). */
  maxDepth?: number;
  /** Stop after this many emitted entries. */
  maxEntries?: number;
  /** Emit each directory's files before its subdirectory entries (and
   * recurse afterwards), so an entry cap can never be consumed by one
   * alphabetical subtree before its later siblings are seen. */
  filesFirst?: boolean;
}

/**
 * Recursively visit the entries under `root`. Symlinks are never followed;
 * hidden entries and `excludedDirs` are skipped; `gitignore` prunes ignored
 * directories and drops ignored files. With `filesFirst` a directory's
 * files are emitted before its subdirectory entries (then each subtree);
 * otherwise entries stream in depth-first sorted order.
 */
export async function* walkEntries(
  root: string,
  options: WalkOptions = {},
): AsyncGenerator<WalkEntry> {
  const skipHidden = options.skipHidden ?? true;
  const maxDepth = options.maxDepth ?? 32;
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  let emitted = 0;

  /** Build the entry for `full` (applying the gitignore filter); undefined
   * when the entry is ignored. */
  const entryFor = (dir: string, name: string): WalkEntry | undefined => {
    const full = join(dir, name);
    const rel = relative(root, full);
    if (options.gitignore?.ignores(root, rel, false)) return undefined;
    return { path: full, rel, isDir: false };
  };

  async function* walk(dir: string, depth: number): AsyncGenerator<WalkEntry> {
    if (depth > maxDepth || emitted >= maxEntries) return;
    let list: DirEntry[];
    try {
      list = [...runtime.readDirSync(dir)];
    } catch {
      return; // unreadable directory (permissions, race) — skip
    }
    list.sort((a, b) => a.name.localeCompare(b.name));

    const filtered = list.filter((entry) => {
      if (entry.isSymlink) return false; // never follow symlinks
      if (skipHidden && entry.name.startsWith(".")) return false;
      if (entry.isDirectory && options.excludedDirs?.has(entry.name)) {
        return false;
      }
      return true;
    });

    if (options.filesFirst === true) {
      // Files first: emit the directory's files, then each subdirectory
      // entry, then recurse into it.
      const subdirs: DirEntry[] = [];
      for (const entry of filtered) {
        if (entry.isDirectory) {
          subdirs.push(entry);
          continue;
        }
        if (!entry.isFile) continue;
        const item = entryFor(dir, entry.name);
        if (item === undefined) continue;
        if (emitted >= maxEntries) return;
        emitted++;
        yield item;
      }
      for (const entry of subdirs) {
        if (emitted >= maxEntries) return;
        const full = join(dir, entry.name);
        const rel = relative(root, full);
        if (options.gitignore?.ignores(root, rel, true)) continue;
        emitted++;
        yield { path: full, rel, isDir: true };
        yield* walk(full, depth + 1);
      }
      return;
    }

    // Depth-first in sorted order: directories recurse immediately, files
    // yield as encountered.
    for (const entry of filtered) {
      if (emitted >= maxEntries) return;
      if (entry.isDirectory) {
        const full = join(dir, entry.name);
        const rel = relative(root, full);
        // An ignored directory means everything below it is ignored too.
        if (options.gitignore?.ignores(root, rel, true)) continue;
        yield* walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile) continue;
      const item = entryFor(dir, entry.name);
      if (item === undefined) continue;
      emitted++;
      yield item;
    }
  }

  yield* walk(root, 0);
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
        const canonical = await runtime.realPath(root);
        const text = await runtime.readTextFile(join(canonical, ".gitignore"));
        rulesByRoot.set(canonical, parseGitignore(text));
      } catch {
        // No .gitignore in this root (or the root no longer exists).
      }
    }
    return new GitignoreMatcher(rulesByRoot);
  }

  /** A matcher built from `.gitignore` text a caller already read (the
   * stella VM backend, whose files are not on this machine's disk, reads it
   * through its own exec seam). `root` must be the absolute root the rules
   * are relative to. */
  static fromText(root: string, text: string): GitignoreMatcher {
    return new GitignoreMatcher(new Map([[root, parseGitignore(text)]]));
  }

  /** True when `relPath` (relative to `walkRoot`) is ignored. `walkRoot`
   * may be a workspace root or any directory inside it — the owning root's
   * rules are found by containment and the path is re-based onto that root,
   * so anchored patterns match correctly for subdirectory walks. `isDir`
   * matters for directory-only rules; an ignored directory means everything
   * below it is ignored (the walker prunes it). */
  ignores(walkRoot: string, relPath: string, isDir: boolean): boolean {
    for (const [root, rules] of this.rulesByRoot) {
      if (!isWithin(root, walkRoot)) continue;
      // Rules are root-relative; re-base the walk-relative path.
      const rootRelative = relative(root, join(walkRoot, relPath)).replace(
        /\\/g,
        "/",
      );
      return applyRules(rules, rootRelative, isDir);
    }
    return false;
  }
}

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
