import { assert, assertEquals } from "@std/assert";

/**
 * The web bundle's dependency rule (ARCHITECTURE.md 1): at runtime it may
 * import the core's pure helpers only — the shared/ module (front-end-safe
 * functions and constants), the static mode definitions and the skill
 * prompt builder. Everything else the core offers reaches the browser as
 * types, which esbuild erases.
 *
 * Nothing enforced the rule, so a value import of the core barrel (or of,
 * say, `@lumisca/core/skills/discover`, which pulls `node:path`) would have
 * been bundled into the client without a single test noticing. This test
 * reads the package's own sources and fails on the first such import.
 */

/** Core entry points the bundle may use at runtime. Keep in sync with the
 * esbuild/Vite aliases and with ARCHITECTURE.md 1. */
const RUNTIME_ALLOWED = [
  "@lumisca/core/shared",
  "@lumisca/core/modes",
  "@lumisca/core/skills/slash",
];

/** The core barrel: types only, so the whole package is never bundled. */
const TYPES_ONLY = ["@lumisca/core"];

const CORE_PREFIX = "@lumisca/core";

interface SourceFile {
  url: URL;
  path: string;
}

async function* sourceFiles(
  dir: URL,
  prefix = "",
): AsyncGenerator<SourceFile> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      yield* sourceFiles(
        new URL(`${entry.name}/`, dir),
        `${prefix}${entry.name}/`,
      );
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      // Tests are not part of the bundle: they run under Deno with the
      // whole core available, so importing its fixtures (or the barrel)
      // there is fine.
      if (entry.name.includes("_test.")) continue;
      yield { url: new URL(entry.name, dir), path: `${prefix}${entry.name}` };
    }
  }
}

/** Import/export statements of a module, as written (deno fmt starts each
 * one on its own line and ends it with a semicolon). */
function statements(source: string): string[] {
  return [...source.matchAll(/^(?:import|export)\b[\s\S]*?;/gm)].map((m) =>
    m[0]
  );
}

function specifierOf(statement: string): string | undefined {
  return statement.match(/from\s+"([^"]+)"/)?.[1];
}

Deno.test("the web bundle imports only the core's pure modules", async () => {
  const violations: string[] = [];
  let inspected = 0;

  for await (const file of sourceFiles(new URL("./", import.meta.url))) {
    const source = await Deno.readTextFile(file.url);
    inspected++;

    const report = (specifier: string, detail: string) => {
      violations.push(`${file.path}: ${detail} ("${specifier}")`);
    };

    for (const statement of statements(source)) {
      const specifier = specifierOf(statement);
      if (specifier === undefined || !specifier.startsWith(CORE_PREFIX)) {
        continue;
      }
      if (/^(?:import|export)\s+type\b/.test(statement)) continue;
      if (TYPES_ONLY.includes(specifier)) {
        report(specifier, "a value import of the core barrel is not allowed");
        continue;
      }
      if (!RUNTIME_ALLOWED.includes(specifier)) {
        report(specifier, "not in the runtime allow-list");
      }
    }

    for (const match of source.matchAll(/import\(\s*"([^"]+)"\s*\)/g)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(CORE_PREFIX)) continue;
      if (!RUNTIME_ALLOWED.includes(specifier)) {
        report(specifier, "not in the runtime allow-list (dynamic import)");
      }
    }
  }

  assert(inspected > 50, `only ${inspected} web sources were inspected`);
  assertEquals(violations, [], violations.join("\n"));
});
