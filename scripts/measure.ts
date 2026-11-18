/**
 * The numbers the refactoring plan is judged by, printed as one table.
 *
 * Nothing here fails a build: it exists so a change that claims to reduce a
 * figure can show the before and after instead of arguing about it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Files {
  source: string[];
  test: string[];
}

function walk(dir: string, out: Files = { source: [], test: [] }): Files {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "target" || entry === "gen") {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, out);
      continue;
    }
    if (!/\.(ts|tsx|css|rs)$/.test(entry)) continue;
    if (entry.includes("_test.")) out.test.push(path);
    else out.source.push(path);
  }
  return out;
}

const linesOf = (path: string) => readFileSync(path, "utf8").split("\n").length;
const total = (files: string[]) =>
  files.reduce((sum, path) => sum + linesOf(path), 0);

const packages = ["core", "server", "web", "desktop", "browser-rpc"] as const;
const rows: Array<[string, number, number, number]> = [];
let allSource = 0;
let allTest = 0;
const sourceFiles: string[] = [];
for (const name of packages) {
  const files = walk(join(ROOT, "packages", name));
  const source = total(files.source);
  const test = total(files.test);
  allSource += source;
  allTest += test;
  sourceFiles.push(...files.source);
  rows.push([name, source, test, files.source.length]);
}

const largest = sourceFiles
  .map((path) => [relative(ROOT, path), linesOf(path)] as const)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8);

const coreText = readFileSync(join(ROOT, "packages/core/core.ts"), "utf8");
const coreMethods = [
  ...coreText.matchAll(
    /^ {2}(?:async |get |set |private |public |protected |static )*[A-Za-z_]\w*\s*\(/gm,
  ),
].length;

function countRefs(pattern: RegExp): number {
  let count = 0;
  for (const path of sourceFiles) {
    count += readFileSync(path, "utf8").match(pattern)?.length ?? 0;
  }
  return count;
}

console.log("package        source     test  files");
for (const [name, source, test, files] of rows) {
  console.log(
    `${name.padEnd(13)} ${String(source).padStart(7)} ${String(test).padStart(7)} ${String(files).padStart(6)}`,
  );
}
console.log(
  `${"total".padEnd(13)} ${String(allSource).padStart(7)} ${String(allTest).padStart(7)}`,
);
console.log("\nlargest non-test files");
for (const [path, lines] of largest)
  console.log(`  ${String(lines).padStart(5)} ${path}`);
console.log("\nmarkers");
console.log(`  core.ts methods        ${coreMethods}`);
console.log(`  Deno. references       ${countRefs(/\bDeno\./g)}`);
console.log(`  runtime. references    ${countRefs(/\bruntime\./g)}`);
console.log(`  preact/compat imports  ${countRefs(/preact\/compat/g)}`);
console.log(`  preact/hooks imports   ${countRefs(/preact\/hooks/g)}`);
