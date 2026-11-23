import { test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals } from "@std/assert";
import {
  browserEntryProblems,
  checkCoreEntryPoints,
  checkCoreSpecifiers,
  checkLayers,
  checkServerCoreImports,
  findCycles,
  runtimeSpecifiers,
} from "./check-architecture.ts";

/** A throwaway tree for the graph tests. */
function fixture(): {
  root: string;
  write: (path: string, text: string) => string;
} {
  const root = mkdtempSync(join(tmpdir(), "lumisca-arch-"));
  return {
    root,
    write(path, text) {
      const full = join(root, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, text);
      return full;
    },
  };
}

test("runtimeSpecifiers sees every import form", () => {
  const specs = runtimeSpecifiers(
    [
      'import type { A } from "./types";',
      'import { type B, C } from "./mixed";',
      'import x from "./default";',
      'import * as ns from "./namespace";',
      'export * from "./barrel";',
      'const late = import("./dynamic");',
      'import "./side-effect";',
    ].join("\n"),
  );
  assertEquals(
    [...specs].sort(),
    [
      "./mixed",
      "./default",
      "./namespace",
      "./barrel",
      "./dynamic",
      "./side-effect",
    ].sort(),
  );
});

test("a cycle made only of export-star is detected", () => {
  const tree = fixture();
  try {
    const a = tree.write("a/mod.ts", 'export * from "../b/mod.ts";\n');
    const b = tree.write("b/mod.ts", 'export * from "../a/mod.ts";\n');
    const cycles = findCycles([
      { path: a, text: 'export * from "../b/mod.ts";\n' },
      { path: b, text: 'export * from "../a/mod.ts";\n' },
    ]);
    assertEquals(cycles.length, 1);
    assertEquals(cycles[0]!.sort(), [a, b].sort());
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
});

test("a default-import layer violation is detected, a type-only one is not", () => {
  const tree = fixture();
  try {
    const ai = tree.write(
      "packages/core/ai/agent.ts",
      [
        'import session from "../session/store.ts";',
        'import type { Row } from "../session/store.ts";',
        "export const x = session;",
      ].join("\n"),
    );
    const store = tree.write(
      "packages/core/session/store.ts",
      "export default {};\nexport type Row = number;\n",
    );
    const problems = checkLayers(
      [
        {
          path: ai,
          text: 'import session from "../session/store.ts";\nimport type { Row } from "../session/store.ts";',
        },
        {
          path: store,
          text: "export default {};\nexport type Row = number;\n",
        },
      ],
      tree.root,
    );
    assertEquals(problems.length, 1);
    assertEquals(problems[0]!.includes("agent.ts"), true);
    assertEquals(problems[0]!.includes("store.ts"), true);
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
});

test("every browser entry is compared, not just the first", () => {
  const entries = [
    { specifier: "@lumisca/core/shared", path: "packages/core/shared/mod.ts" },
    { specifier: "@lumisca/core/modes", path: "packages/core/modes/mod.ts" },
    {
      specifier: "@lumisca/core/skills/slash",
      path: "packages/core/skills/slash.ts",
    },
  ];
  assertEquals(browserEntryProblems(entries, {}).length, 3);
  const paths = {
    "@lumisca/core/shared": ["./packages/core/shared/mod.ts"],
    "@lumisca/core/modes": ["./somewhere/else.ts"],
    "@lumisca/core/skills/slash": ["./packages/core/skills/slash.ts"],
  };
  const wrong = browserEntryProblems(entries, paths);
  assertEquals(wrong.length, 1);
  assertEquals(wrong[0]!.startsWith("@lumisca/core/modes:"), true);
});

test("only public core specifiers pass", () => {
  const problems = checkCoreSpecifiers([
    { path: "/repo/packages/core/a.ts", text: 'import "@lumisca/core";' },
    {
      path: "/repo/packages/core/b.ts",
      text: 'import "@lumisca/core/sessions/repo.ts";',
    },
  ]);
  assertEquals(problems.length, 1);
  assertEquals(problems[0]!.includes("@lumisca/core/sessions"), true);
});

test("a server module reaching the core by path is a violation", () => {
  const tree = fixture();
  try {
    const mod = tree.write(
      "packages/server/mod.ts",
      'import { OS } from "../core/platform.ts";\nexport const x = OS;',
    );
    const fsRoute = tree.write(
      "packages/server/routes/fs.ts",
      'import { OS } from "@lumisca/core/platform";\nexport const x = OS;',
    );
    const test = tree.write(
      "packages/server/a_test.ts",
      'import { OS } from "../../core/platform.ts";\nexport const x = OS;',
    );
    tree.write("packages/core/platform.ts", "export const OS = 1;\n");
    const sources = [
      { path: mod, text: readFileSync(mod, "utf8") },
      { path: fsRoute, text: readFileSync(fsRoute, "utf8") },
      { path: test, text: readFileSync(test, "utf8") },
    ];
    const problems = checkServerCoreImports(sources, tree.root);
    assertEquals(problems.length, 1);
    assertEquals(problems[0]!.includes("packages/server/mod.ts"), true);
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
});

test("an entry point exported but not in the lists is a disagreement", () => {
  const entries = new Map([
    ["@lumisca/core", "./mod.ts"],
    ["@lumisca/core/platform", "./platform.ts"],
  ]);
  const paths = {
    "@lumisca/core": ["./packages/core/mod.ts"],
    "@lumisca/core/platform": ["./packages/core/elsewhere.ts"],
  };
  const problems = checkCoreEntryPoints(entries, paths);
  // `platform` points somewhere else, and every other CORE_SPECIFIERS
  // entry is missing from the map.
  assertEquals(
    problems.some((p) => p.startsWith("@lumisca/core/platform:")),
    true,
  );
  assertEquals(
    problems.some((p) => p.startsWith("@lumisca/core/bytes:")),
    true,
  );
  assertEquals(
    problems.some((p) => p.startsWith("@lumisca/core:")),
    false,
  );
});
