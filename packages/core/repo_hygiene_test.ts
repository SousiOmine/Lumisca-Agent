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

Deno.test("sources carry no mojibake from a legacy code page", async () => {
  const offenders: string[] = [];
  let scanned = 0;
  for await (const file of textFiles()) {
    scanned++;
    const text = await Deno.readTextFile(file.url);
    const found = MOJIBAKE.exec(text);
    if (found !== null) offenders.push(`${file.path} (${found[0]})`);
  }
  // A walk that silently visited nothing would pass vacuously.
  assert(scanned > 300, `the source walk found only ${scanned} files`);
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
  // the Linux step, `$dir =` in the Windows one. A rename is a deliberate
  // decision, so both are expected to be there.
  const assignments = workflow.split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(DIR=|\$dir = )/.test(line));
  assertEquals(
    assignments.length,
    2,
    `the packaging steps name ${assignments.length} director(ies); ` +
      "update this check if the packaging changed",
  );
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
  for await (const file of textFiles()) {
    if (
      !file.path.startsWith("packages/") && !file.path.startsWith("scripts/")
    ) {
      continue;
    }
    if (!file.path.endsWith(".ts") && !file.path.endsWith(".tsx")) continue;
    // The catalogue itself must not count as a usage.
    if (file.path.startsWith("packages/core/shared/i18n/")) continue;
    sources.push(await Deno.readTextFile(file.url));
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
