import { assertEquals } from "@std/assert";
import { parsePluginManifest, PLUGIN_SCHEMA_URL } from "./manifest.ts";

const FULL = {
  $schema: PLUGIN_SCHEMA_URL,
  name: "acme.tools",
  version: "1.2.0",
  description: "Brief plugin description",
  author: { name: "Author Name", email: "author@example.com" },
  homepage: "https://docs.example.com/plugin",
  repository: "https://github.com/example/plugin",
  license: "MIT",
  keywords: ["keyword1", "keyword2"],
  extensions: { "com.example.client": { setting: true } },
};

// --- valid manifests ----------------------------------------------------------

Deno.test("parsePluginManifest accepts the minimal manifest", () => {
  const result = parsePluginManifest(
    JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: "minimal-plugin" }),
    "plugin.json",
  );
  assertEquals(result.fatal, undefined);
  assertEquals(result.manifest, { name: "minimal-plugin" });
});

Deno.test("parsePluginManifest accepts the full manifest", () => {
  const result = parsePluginManifest(JSON.stringify(FULL), "plugin.json");
  assertEquals(result.fatal, undefined);
  assertEquals(result.warnings, []);
  // `$schema` is the version selector and is not part of the manifest
  // data itself.
  const { $schema: _schema, ...expected } = FULL;
  assertEquals(result.manifest, expected);
});

Deno.test("parsePluginManifest accepts every valid name", () => {
  for (const name of ["my-plugin", "acme.tools", "lint3r", "a"]) {
    const result = parsePluginManifest(
      JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name }),
      "plugin.json",
    );
    assertEquals(result.fatal, undefined, `name "${name}" should be valid`);
  }
});

// --- fatal violations ---------------------------------------------------------

Deno.test("parsePluginManifest rejects invalid JSON", () => {
  const result = parsePluginManifest("{ not json", "plugin.json");
  assertFatal(result.fatal, "not valid JSON");
});

Deno.test("parsePluginManifest rejects a non-object document", () => {
  const result = parsePluginManifest('["array"]', "plugin.json");
  assertFatal(result.fatal, "JSON object");
});

Deno.test("parsePluginManifest rejects a missing $schema", () => {
  const result = parsePluginManifest('{"name": "x"}', "plugin.json");
  assertFatal(result.fatal, "$schema");
});

Deno.test("parsePluginManifest rejects an unsupported $schema", () => {
  const result = parsePluginManifest(
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/0.9.0/plugin.schema.json",
      name: "x",
    }),
    "plugin.json",
  );
  assertFatal(result.fatal, "unsupported $schema");
});

Deno.test("parsePluginManifest rejects invalid names", () => {
  for (
    const name of [
      "",
      "My-Plugin",
      "-start",
      "end-",
      "has--double",
      "too.many..dots",
      "x".repeat(65),
    ]
  ) {
    const result = parsePluginManifest(
      JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name }),
      "plugin.json",
    );
    assertFatal(result.fatal, "name", `name "${name}" should be rejected`);
  }
});

Deno.test("parsePluginManifest rejects wrong-typed known fields", () => {
  for (
    const [key, value] of [
      ["version", 1],
      ["description", []],
      ["homepage", true],
      ["license", null],
      ["keywords", "not-an-array"],
      ["keywords", ["ok", 42]],
    ] as const
  ) {
    const result = parsePluginManifest(
      JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: "x", [key]: value }),
      "plugin.json",
    );
    assertFatal(result.fatal, `"${key}"`, `field ${key}`);
  }
});

Deno.test("parsePluginManifest rejects a malformed author", () => {
  for (const author of ["string", [], { name: 42 }, { extra: "x" }]) {
    const result = parsePluginManifest(
      JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: "x", author }),
      "plugin.json",
    );
    assertFatal(result.fatal, "author");
  }
});

// --- non-fatal violations (report and ignore) --------------------------------

Deno.test("parsePluginManifest reports and ignores unknown top-level fields", () => {
  const result = parsePluginManifest(
    JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: "x", bogus: 1 }),
    "plugin.json",
  );
  assertEquals(result.fatal, undefined);
  assertEquals(result.manifest?.name, "x");
  assertEquals(result.warnings.length, 1);
  assertEquals(
    result.warnings[0],
    'plugin.json: unknown top-level field "bogus" ignored',
  );
});

Deno.test("parsePluginManifest reports and ignores a non-object extensions", () => {
  for (const extensions of [42, "nope", []]) {
    const result = parsePluginManifest(
      JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: "x", extensions }),
      "plugin.json",
    );
    assertEquals(result.fatal, undefined);
    assertEquals(result.warnings.length, 1);
    assertEquals(
      result.warnings[0],
      'plugin.json: "extensions" is not an object; ignored',
    );
  }
});

function assertFatal(
  fatal: string | undefined,
  needle: string,
  label?: string,
): void {
  assertEquals(
    typeof fatal === "string" && fatal.includes(needle),
    true,
    `${label ?? "expected fatal"}: ${fatal}`,
  );
}
