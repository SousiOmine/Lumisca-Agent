import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { repoRoot } from "./lib.ts";
import {
  auditSuiteList,
  discoverTestFiles,
  INTEGRATION_MARKERS,
  partitionTestFiles,
} from "./test-suites.ts";

/**
 * The suite split is a list, so it falls behind the tree in two ways: a file
 * that starts using the machine stays in `unit`, or a listed file is
 * deleted. Neither shows in `bun test` — the first only makes the unit run
 * slower and flakier — so they are checked here.
 */

const discovered = discoverTestFiles(repoRoot);

test("every file that reaches for the machine is in the integration list", () => {
  const { unlisted } = auditSuiteList(repoRoot);
  assertEquals(
    unlisted,
    [],
    `add these to INTEGRATION_SUITE in scripts/test-suites.ts:\n  ${unlisted.join("\n  ")}`,
  );
});

test("every listed file exists", () => {
  const { stale } = auditSuiteList(repoRoot);
  assertEquals(
    stale,
    [],
    `these are gone from the tree; delete them from INTEGRATION_SUITE:\n  ${stale.join("\n  ")}`,
  );
});

test("the two suites together are every test file, with no overlap", () => {
  const { unit, integration } = partitionTestFiles(discovered);
  assertEquals(
    [...unit, ...integration].sort(),
    [...discovered].sort(),
    "a test file belongs to exactly one suite",
  );
  assertEquals(
    unit.filter((file) => integration.includes(file)),
    [],
    "a unit file is also listed as integration",
  );
});

test("the unit suite stays the larger half", () => {
  // A tripwire, not a rule: below this line a marker has grown broad enough
  // to catch tests that never touch the machine, and `test:unit` stops being
  // the fast suite.
  const { unit, integration } = partitionTestFiles(discovered);
  assertEquals(
    unit.length > integration.length,
    true,
    `unit=${unit.length} integration=${integration.length}`,
  );
});

/** Join the parts of a sample so this file carries no marker-shaped text of
 * its own: the audit above reads this source too, and a sample written whole
 * would list this test as integration. */
const sample = (...parts: string[]): string => parts.join("");

test("a marker matches the shape it names", () => {
  const matches = (source: string): boolean =>
    INTEGRATION_MARKERS.some((marker) => marker.test(source));
  const fsPromises = sample("import * as fsp ", "from ", '"node:fs/promises";');
  assertEquals(matches(fsPromises), true);
  assertEquals(
    matches(sample("import { tmpdir } ", "from ", '"node:os";')),
    false,
  );
  assertEquals(
    matches(sample("import { Database } ", "from ", '"bun:sqlite";')),
    true,
  );
  assertEquals(
    matches(sample("const s = ", "Bun.", "serve({ port: 0 });")),
    true,
  );
  assertEquals(matches(sample("Bun.", "serveLater();")), false);
  assertEquals(matches(sample("// pod", "man is not installed")), true);
  assertEquals(
    matches(sample('process.env["LUMISCA_', 'STELLA_LIVE"] === "1"')),
    true,
  );
  assertEquals(matches(sample('process.env["LUMISCA_', 'PORT"]')), false);
});
