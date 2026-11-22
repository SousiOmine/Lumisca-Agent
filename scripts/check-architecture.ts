/**
 * Structural checks the type checker cannot make: import cycles, and the
 * one list of browser-safe entry points agreeing with tsconfig.
 *
 * These are cheap (no build, no network) and run in CI beside `tsc`. A
 * failure prints the offending files so the fix is obvious.
 *
 * The scanner reads the TypeScript syntax tree rather than matching import
 * lines with a regular expression: `import x from`, `import * as x from`,
 * `export * from` and `import()` are all edges, and a pattern that knows
 * only the brace form silently certifies a graph it never saw.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_CORE_ENTRIES } from "../packages/core/browser-entries.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface Source {
  path: string;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.endsWith("target")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, out);
      continue;
    }
    if (
      /\.(ts|tsx)$/.test(entry) &&
      !entry.endsWith(".d.ts") &&
      !entry.includes("_test.")
    ) {
      out.push(path);
    }
  }
  return out;
}

function sources(): Source[] {
  return [
    ...walk(join(ROOT, "packages/core")),
    ...walk(join(ROOT, "packages/server")),
    ...walk(join(ROOT, "packages/web/src")),
  ].map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

/** Resolve a relative specifier the way the bundler does: exact file, then
 * `.ts`/`.tsx`, then a directory's `mod.ts`. */
function resolveSpecifier(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  const candidates = /\.(ts|tsx)$/.test(base)
    ? [base]
    : [
        base + ".ts",
        base + ".tsx",
        join(base, "mod.ts"),
        join(base, "index.ts"),
      ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

/**
 * The specifiers a module loads at runtime. Bun's transpiler already drops
 * type-only imports, which are erased and cannot form a runtime cycle, and
 * reports `export ... from` and `import()` with the same shape as a plain
 * import. A regular expression over import lines saw only the brace form.
 */
interface TranspilerLike {
  scan(text: string): {
    imports: readonly { kind: string; path: string }[];
  };
}
interface BunWithTranspiler {
  Transpiler: new (options: { loader: "ts" | "tsx" }) => TranspilerLike;
}

export function runtimeSpecifiers(
  text: string,
  fileName = "module.ts",
): string[] {
  const Transpiler = (Bun as unknown as BunWithTranspiler).Transpiler;
  const transpiler = new Transpiler({
    loader: fileName.endsWith(".tsx") ? "tsx" : "ts",
  });
  return transpiler
    .scan(text)
    .imports.filter((entry) => entry.kind !== "require-call")
    .map((entry) => entry.path);
}

export function findCycles(files: readonly Source[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const deps: string[] = [];
    for (const specifier of runtimeSpecifiers(file.text, file.path)) {
      const target = resolveSpecifier(file.path, specifier);
      if (target !== undefined) deps.push(target);
    }
    graph.set(file.path, deps);
  }

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let next = 0;

  const visit = (node: string): void => {
    index.set(node, next);
    low.set(node, next);
    next++;
    stack.push(node);
    onStack.add(node);
    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue;
      if (!index.has(dep)) {
        visit(dep);
        low.set(node, Math.min(low.get(node)!, low.get(dep)!));
      } else if (onStack.has(dep)) {
        low.set(node, Math.min(low.get(node)!, index.get(dep)!));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) cycles.push(component);
    }
  };

  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return cycles;
}

/** `packages/core/browser-entries.ts` is the single list the Vite aliases,
 * the esbuild aliases and the boundary test read. tsc reads tsconfig's
 * `paths` instead, so the two must agree or the type check resolves a
 * different module than the bundle ships. The list is imported, not parsed:
 * a regex over its source saw one of the three entries and called the rest
 * absent. */
export function browserEntryProblems(
  entries: readonly { specifier: string; path: string }[],
  paths: Record<string, string[]>,
): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    const configured = paths[entry.specifier];
    if (configured === undefined) {
      problems.push(`${entry.specifier}: missing from tsconfig paths`);
      continue;
    }
    const expected = "./" + entry.path;
    if (!configured.some((candidate) => candidate === expected)) {
      problems.push(
        `${entry.specifier}: tsconfig points at ${configured.join(", ")}, browser-entries at ${expected}`,
      );
    }
  }
  return problems;
}

export function checkBrowserEntries(): string[] {
  const tsconfig = JSON.parse(
    readFileSync(join(ROOT, "tsconfig.json"), "utf8").replace(
      /^\s*\/\/.*$/gm,
      "",
    ),
  ) as { compilerOptions?: { paths?: Record<string, string[]> } };
  return browserEntryProblems(
    BROWSER_CORE_ENTRIES,
    tsconfig.compilerOptions?.paths ?? {},
  );
}

/**
 * The layering rules the plan added:
 * - `ai` is the model boundary and must not read `domain` or `session` at
 *   runtime (types are fine: they are erased);
 * - `session` is storage and must not read `tools`.
 *
 * The cycles check cannot see these because both directions are one-way.
 */
export function checkLayers(files: readonly Source[], root = ROOT): string[] {
  const problems: string[] = [];
  const rules: Array<{ dir: string; forbidden: string[] }> = [
    {
      dir: "packages/core/domain",
      forbidden: [
        "packages/core/ai",
        "packages/core/tools",
        "packages/core/session",
        "packages/core/vm",
        "packages/core/web",
      ],
    },
    {
      dir: "packages/core/ports",
      forbidden: [
        "packages/core/ai",
        "packages/core/tools",
        "packages/core/vm",
        "packages/core/session",
      ],
    },
    {
      dir: "packages/core/vm",
      forbidden: ["packages/core/tools"],
    },
    {
      dir: "packages/core/ai",
      forbidden: ["packages/core/domain", "packages/core/session"],
    },
    { dir: "packages/core/session", forbidden: ["packages/core/tools"] },
  ];
  for (const file of files) {
    const rel = relative(root, file.path);
    const rule = rules.find((r) => rel.startsWith(r.dir + "/"));
    if (rule === undefined) continue;
    for (const specifier of runtimeSpecifiers(file.text, file.path)) {
      const target = resolveSpecifier(file.path, specifier);
      if (target === undefined) continue;
      const targetRel = relative(root, target);
      if (!rule.forbidden.some((f) => targetRel.startsWith(f + "/"))) continue;
      problems.push(
        `${rel} imports ${targetRel} at runtime (${rule.dir.split("/").pop()} may only take its types)`,
      );
    }
  }
  return problems;
}

if (import.meta.main) {
  const files = sources();
  const cycles = findCycles(files);
  const aliasProblems = checkBrowserEntries();
  const layerProblems = checkLayers(files);
  let failed = false;

  if (cycles.length > 0) {
    failed = true;
    console.error(`import cycles: ${cycles.length}`);
    for (const cycle of cycles) {
      console.error(
        "  " + cycle.map((path) => relative(ROOT, path)).join(" <-> "),
      );
    }
  }

  if (aliasProblems.length > 0) {
    failed = true;
    console.error("browser entry points and tsconfig disagree:");
    for (const problem of aliasProblems) console.error("  " + problem);
  }

  if (layerProblems.length > 0) {
    failed = true;
    console.error("layer violations:");
    for (const problem of layerProblems) console.error("  " + problem);
  }

  if (failed) process.exit(1);
  console.log("architecture: acyclic, browser entries in sync, layers intact");
}
