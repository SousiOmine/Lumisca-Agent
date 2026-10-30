import { assert, assertEquals } from "@std/assert";
import { messages } from "./shared/i18n/messages.ts";

/**
 * Cross-cutting source checks. Both of them need the whole repository
 * rather than one module's behaviour, so they live beside the other
 * repository-wide suite (stack_smoke_test.ts) instead of inside a module's
 * tests.
 */

/** Repository root: this file is `packages/core/<name>.ts`. */
const ROOT = new URL("../../", import.meta.url);

/** Directories that hold no first-party text: dependencies, build output,
 * VCS metadata, scratch directories and binary fixtures. */
const SKIP_DIRS = new Set([
  ".git",
  ".lumisca-cache",
  ".playwright-mcp",
  ".vite",
  ".vscode",
  ".zcode",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "testdata",
]);

/** Extensions that hold first-party text. */
const TEXT_EXTENSIONS = [
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".rs",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
];

interface SourceFile {
  url: URL;
  /** Path relative to the repository root, always with "/" separators. */
  path: string;
}

/** Every text file under the repository root, scratch directories aside. */
async function* textFiles(
  dir: URL = ROOT,
  prefix = "",
): AsyncGenerator<SourceFile> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".tmp-")) {
        continue;
      }
      // The entry name is a path segment, not a URL segment: a legal file
      // name may carry characters like ":" or "#", and new URL would then
      // build something readDir rejects ("Must be a file URL"), taking both
      // hygiene tests down with it. Only the URL is encoded; the reported
      // path keeps the raw name.
      yield* textFiles(
        new URL(`${encodeURIComponent(entry.name)}/`, dir),
        `${prefix}${entry.name}/`,
      );
    } else if (TEXT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      yield {
        url: new URL(encodeURIComponent(entry.name), dir),
        path: `${prefix}${entry.name}`,
      };
    }
  }
}

/**
 * Code points that only show up when UTF-8 text was read as a legacy
 * Japanese code page: a dash becomes U+7AB6, and the kana/kanji lemmas
 * U+7E3A, U+7E67, U+7E5D and U+8B41 cover the rest. U+FFFD is the
 * replacement character a lossy decode leaves behind. None of them belongs
 * in a source file, and one that reached a translated string would be
 * shown to the user. The literals are written as escapes so that this file
 * does not match its own pattern.
 */
const MOJIBAKE = /[\uFFFD\u7AB6\u7E3A\u7E67\u7E5D\u8B41]/;

/**
 * Every first-party text file, read once. The source-wide checks below each
 * need the whole tree, and reading it per check walked the repository twice
 * (the i18n scan alone took ~1s). One walk, one read, both checks share it.
 */
let sourceCache: SourceFile[] | undefined;
async function allSources(): Promise<SourceFile[]> {
  if (sourceCache !== undefined) return sourceCache;
  const files: SourceFile[] = [];
  for await (const file of textFiles()) files.push(file);
  sourceCache = files;
  return files;
}

/** The contents of every source file, keyed by its repo-relative path. The
 * walk that produced it is the same one allSources() returns, so a check
 * cannot see a different tree than another. */
let textCache: Map<string, string> | undefined;
async function sourceTexts(): Promise<Map<string, string>> {
  if (textCache !== undefined) return textCache;
  const texts = new Map<string, string>();
  for (const file of await allSources()) {
    texts.set(file.path, await Deno.readTextFile(file.url));
  }
  textCache = texts;
  return texts;
}

Deno.test("sources carry no mojibake from a legacy code page", async () => {
  const texts = await sourceTexts();
  // A walk that silently visited nothing would pass vacuously.
  assert(texts.size > 300, `the source walk found only ${texts.size} files`);
  const offenders: string[] = [];
  for (const [path, text] of texts) {
    const found = MOJIBAKE.exec(text);
    if (found !== null) offenders.push(`${path} (${found[0]})`);
  }
  assertEquals(offenders, [], `mojibake found in: ${offenders.join(", ")}`);
});

/**
 * The directory a release archive unpacks to carries no version. The server
 * replaces its own files in place on update (packages/server/update/
 * install.ts), so a version baked into that name would keep advertising the
 * release the directory was *first* unpacked from — and that name is what
 * `ps`, a generated service unit and a support conversation show. A
 * version-free name cannot be misread. The version is answered by the
 * archive's file name (scripts/build-server-manifest.ts refuses a mismatch),
 * the release manifest and the binary itself (`--version`).
 */
Deno.test("a packaged install directory carries no version", async () => {
  const workflow = await Deno.readTextFile(
    new URL(".github/workflows/release.yml", ROOT),
  );
  // The packaging steps name the directory the archive unpacks to: `DIR=` in
  // the Linux step, `$dir =` in the Windows one. The count is not pinned
  // (a step may be split or added without meaning anything); what matters is
  // that the packaging is found at all — a renamed variable would otherwise
  // make this check pass by inspecting nothing.
  const assignments = workflow.split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(DIR=|\$dir = )/.test(line));
  assert(
    assignments.length > 0,
    "no packaged install directory is named in release.yml: the check found " +
      "nothing to verify",
  );
  for (const line of assignments) {
    assert(
      !/version/i.test(line),
      `the packaged install directory name carries a version: ${line}`,
    );
  }
  for (const line of assignments) {
    assert(
      !/version/i.test(line),
      `the packaged install directory name carries a version: ${line}`,
    );
  }
});

Deno.test("every i18n catalogue key is referenced by some source", async () => {
  // The catalogue test (shared/i18n_test.ts) proves the entries are
  // complete and translated; nothing proves they are still used, so a key
  // whose last caller was deleted outlives it silently. Keys are only ever
  // passed as quoted literals (`t("…")`, `translate(locale, "…")`), which is
  // what this search relies on.
  const sources: string[] = [];
  for (const [path, text] of await sourceTexts()) {
    if (!path.startsWith("packages/") && !path.startsWith("scripts/")) {
      continue;
    }
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
    // The catalogue itself must not count as a usage.
    if (path.startsWith("packages/core/shared/i18n/")) continue;
    sources.push(text);
  }
  assert(sources.length > 300, `only ${sources.length} sources were read`);

  const haystack = sources.join("\n");
  const unused = Object.keys(messages).filter((key) =>
    !haystack.includes(`"${key}"`)
  );
  assertEquals(
    unused,
    [],
    `i18n keys with no caller (delete them): ${unused.join(", ")}`,
  );
});
