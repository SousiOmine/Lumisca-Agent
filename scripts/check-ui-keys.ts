/**
 * The i18n catalogue is compile-time checked: `t("…")` only accepts a
 * `MessageKey`. Two things the compiler cannot see are checked here.
 *
 * 1. A key nothing references. It either lost its last caller or was added
 *    and never used; both leave the catalog lying about the strings the app
 *    has.
 * 2. A `t("…")` whose key is missing. TypeScript catches this in the web
 *    package (the key space is a union), but not in a template string or a
 *    cast the catalogue test would otherwise never see.
 *
 * References are counted across the core, the server and the web: strings
 * the server composes (notifications, web-search failure reasons) are keys
 * too, even though no `.tsx` file mentions them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CATALOG = join(ROOT, "packages/core/shared/i18n");
const SKIP = new Set(["mod.ts", "types.ts", "messages.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "target") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

function catalogKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const entry of readdirSync(CATALOG)) {
    if (!entry.endsWith(".ts") || entry.includes("_test.") || SKIP.has(entry)) {
      continue;
    }
    const text = readFileSync(join(CATALOG, entry), "utf8");
    for (const match of text.matchAll(/^\s*"([a-z0-9_.]+)":\s*\{/gm)) {
      keys.set(match[1]!, entry);
    }
  }
  return keys;
}

const keys = catalogKeys();
const sources = [
  ...walk(join(ROOT, "packages/core")),
  ...walk(join(ROOT, "packages/server")),
  ...walk(join(ROOT, "packages/web/src")),
  ...walk(join(ROOT, "scripts")),
].filter((path) => !path.startsWith(CATALOG));

const referenced = new Set<string>();
const missing = new Set<string>();
for (const path of sources) {
  const text = readFileSync(path, "utf8");
  for (const match of text.matchAll(
    /\bt\(\s*"((?:common|chrome|settings|chat|panels|setup)\.[a-z0-9_.]+)"/g,
  )) {
    if (!keys.has(match[1]!))
      missing.add(`${match[1]} (${relative(ROOT, path)})`);
  }
  for (const match of text.matchAll(
    /\btranslate\(\s*"((?:common|chrome|settings|chat|panels|setup)\.[a-z0-9_.]+)"/g,
  )) {
    if (!keys.has(match[1]!))
      missing.add(`${match[1]} (${relative(ROOT, path)})`);
  }
  for (const key of keys.keys()) {
    if (text.includes(`"${key}"`)) referenced.add(key);
  }
}

const unused = [...keys.entries()]
  .filter(([key]) => !referenced.has(key))
  .map(([key, file]) => `${key} (${file})`);

let failed = false;
if (unused.length > 0) {
  failed = true;
  console.error(`unused catalogue keys: ${unused.length}`);
  for (const entry of unused) console.error("  " + entry);
}
if (missing.size > 0) {
  failed = true;
  console.error(`keys used but not in the catalogue: ${missing.size}`);
  for (const entry of missing) console.error("  " + entry);
}
if (failed) process.exit(1);
console.log(`i18n: ${keys.size} keys, every one referenced and defined`);
