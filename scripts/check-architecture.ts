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

const IMPORT = /(?:from\s+|import\s*\()\s*"(\.[^"]+)"/g;

function findCycles(): string[][] {
  const files = sources();
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const deps: string[] = [];
    for (const match of file.text.matchAll(IMPORT)) {
      const target = resolveSpecifier(file.path, match[1]!);
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

const cycles = findCycles();
const aliasProblems = checkBrowserEntries();
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

if (failed) process.exit(1);
console.log("architecture: import graph acyclic, browser entries in sync");
