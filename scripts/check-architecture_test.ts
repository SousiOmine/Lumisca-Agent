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
  corePathProblems,
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

test("an internal subpath is rejected however it is written", () => {
  const problems = checkCoreSpecifiers([
    // Every public entry point, in the form a module writes it.
    {
      path: "/repo/packages/core/ok.ts",
      text: [
        'import { a } from "@lumisca/core";',
        'import { b } from "@lumisca/core/shared";',
        'import { c } from "@lumisca/core/modes";',
        'import { d } from "@lumisca/core/skills/slash";',
        'import { e } from "@lumisca/core/browser-entries";',
        'import { f } from "@lumisca/core/test-utils";',
        'import { g } from "@lumisca/core/bytes";',
      ].join("\n"),
    },
    // A type-only import still names a boundary the barrel does not offer.
    {
      path: "/repo/packages/core/type.ts",
      text: 'import type { Row } from "@lumisca/core/session/store";',
    },
    // Single quotes, and a subpath of a public entry point.
    {
      path: "/repo/packages/core/quoted.ts",
      text: "import { x } from '@lumisca/core/shared/ui-app/mod.ts';",
    },
    // A specifier without a trailing slash: the old regex only saw those.
    {
      path: "/repo/packages/core/bare.ts",
      text: 'export * from "@lumisca/core/session";',
    },
  ]);
  assertEquals(
    problems.map((problem) => problem.split(" imports ")[1]!.split(" ")[0]),
    [
      "@lumisca/core/session/store",
      "@lumisca/core/shared/ui-app/mod.ts",
      "@lumisca/core/session",
    ],
  );
});

test("tsconfig paths must be exactly the public core specifiers", () => {
  const exact = {
    "@lumisca/core": ["./packages/core/mod.ts"],
    "@lumisca/core/bytes": ["./packages/core/bytes.ts"],
    "@lumisca/core/shared": ["./packages/core/shared/mod.ts"],
    "@lumisca/core/modes": ["./packages/core/modes/mod.ts"],
    "@lumisca/core/skills/slash": ["./packages/core/skills/slash.ts"],
    "@lumisca/core/browser-entries": ["./packages/core/browser-entries.ts"],
    "@lumisca/core/test-utils": ["./packages/core/test-utils.ts"],
    "@lumisca/core/base64": ["./packages/core/base64.ts"],
    "@lumisca/core/errors": ["./packages/core/errors.ts"],
    "@lumisca/core/media/preview": ["./packages/core/media/preview.ts"],
    "@lumisca/core/media/preview-cache": [
      "./packages/core/media/preview-cache.ts",
    ],
    "@lumisca/core/media/stored-image": [
      "./packages/core/media/stored-image.ts",
    ],
    "@lumisca/core/notify/subscriptions": [
      "./packages/core/notify/subscriptions.ts",
    ],
    "@lumisca/core/platform": ["./packages/core/platform.ts"],
    "@lumisca/core/process": ["./packages/core/process.ts"],
    "@lumisca/core/settings/repo": ["./packages/core/settings/repo.ts"],
    "@lumisca/server": ["./packages/server/mod.ts"],
  };
  // A paths table for something else is not this rule's business.
  assertEquals(corePathProblems(exact), []);

  const wildcard = corePathProblems({
    ...exact,
    "@lumisca/core/*": ["./packages/core/*"],
  });
  assertEquals(wildcard.length, 1);
  assertEquals(wildcard[0]!.includes("@lumisca/core/*"), true);

  const { "@lumisca/core/bytes": _dropped, ...missing } = exact;
  const problems = corePathProblems(missing);
  assertEquals(problems.length, 1);
  assertEquals(problems[0]!.includes("@lumisca/core/bytes"), true);
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
