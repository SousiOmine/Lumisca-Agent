/**
 * Structural checks the type checker cannot make: import cycles, and the
 * one list of browser-safe entry points agreeing with tsconfig.
 *
 * These are cheap (no build, no network) and run in CI beside `tsc`. A
 * failure prints the offending files so the fix is obvious.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Source {
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
    if (/\.(ts|tsx)$/.test(entry) && !entry.includes("_test.")) out.push(path);
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
 * The specifiers a module loads at runtime. Type-only imports are erased and
 * cannot form a runtime cycle; after the split of `ai/types.ts` the type
 * modules point at one another by design.
 */
function runtimeSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(
    /import\s+(type\s+)?(\{[^}]*\}|\*\s+as\s+\w+|[\w]+)\s+from\s+"(\.[^"]+)"/g,
  )) {
    const names = match[2]!.startsWith("{")
      ? match[2]!
          .slice(1, -1)
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
      : [];
    const typeOnly =
      match[1] !== undefined ||
      (names.length > 0 && names.every((name) => name.startsWith("type ")));
    if (!typeOnly) out.push(match[3]!);
  }
  for (const match of text.matchAll(/import\s*\(\s*"(\.[^"]+)"/g)) {
    out.push(match[1]!);
  }
  return out;
}

function findCycles(): string[][] {
  const files = sources();
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const deps: string[] = [];
    for (const specifier of runtimeSpecifiers(file.text)) {
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
 * different module than the bundle ships. */
function checkBrowserEntries(): string[] {
  const problems: string[] = [];
  const entries = readFileSync(
    join(ROOT, "packages/core/browser-entries.ts"),
    "utf8",
  );
  const declared = [
    ...entries.matchAll(/specifier:\s*"([^"]+)",\s*\n\s*path:\s*"([^"]+)"/g),
  ];
  const tsconfig = JSON.parse(
    readFileSync(join(ROOT, "tsconfig.json"), "utf8").replace(
      /^\s*\/\/.*$/gm,
      "",
    ),
  ) as { compilerOptions?: { paths?: Record<string, string[]> } };
  const paths = tsconfig.compilerOptions?.paths ?? {};
  for (const match of declared) {
    const [, specifier, path] = match;
    const configured = paths[specifier!];
    if (configured === undefined) {
      problems.push(`${specifier}: missing from tsconfig paths`);
      continue;
    }
    const expected = "./" + path;
    if (!configured.some((entry) => entry === expected)) {
      problems.push(
        `${specifier}: tsconfig points at ${configured.join(", ")}, browser-entries at ${expected}`,
      );
    }
  }
  return problems;
}

/**
 * The layering rules the plan added:
 * - `ai` is the model boundary and must not read `domain` or `session` at
 *   runtime (types are fine: they are erased);
 * - `session` is storage and must not read `tools`.
 *
 * The cycles check cannot see these because both directions are one-way.
 */
function checkLayers(): string[] {
  const problems: string[] = [];
  const rules: Array<{ dir: string; forbidden: string[] }> = [
    {
      dir: "packages/core/ai",
      forbidden: ["packages/core/domain", "packages/core/session"],
    },
    { dir: "packages/core/session", forbidden: ["packages/core/tools"] },
  ];
  for (const file of sources()) {
    const rel = relative(ROOT, file.path);
    const rule = rules.find((r) => rel.startsWith(r.dir + "/"));
    if (rule === undefined) continue;
    for (const match of file.text.matchAll(
      /import\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g,
    )) {
      const target = resolveSpecifier(file.path, match[3]!);
      if (target === undefined) continue;
      const targetRel = relative(ROOT, target);
      if (!rule.forbidden.some((f) => targetRel.startsWith(f + "/"))) continue;
      const declarationIsTypeOnly =
        match[1] !== undefined ||
        match[2]!
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
          .every((n) => n.startsWith("type "));
      if (declarationIsTypeOnly) continue;
      problems.push(
        `${rel} imports ${targetRel} at runtime (${rule.dir.split("/").pop()} may only take its types)`,
      );
    }
  }
  return problems;
}

const cycles = findCycles();
const aliasProblems = checkBrowserEntries();
const layerProblems = checkLayers();
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
