import { assert, assertEquals } from "@std/assert";
import { PROBE_SOURCE } from "./probe.js";

Deno.test("probe source parses as JavaScript", () => {
  try {
    new Function(PROBE_SOURCE);
  } catch (error) {
    throw new Error(
      `probe.js は構文エラーです: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
});

Deno.test("probe source stays embeddable (no backticks, no ${)", () => {
  // The probe lives inside a String.raw template literal; backticks would
  // terminate it and "${" would interpolate. Both would silently corrupt
  // the Rust-extracted copy.
  assert(!PROBE_SOURCE.includes("`"), "probe must not contain backticks");
  assert(!PROBE_SOURCE.includes("${"), "probe must not contain ${");
});

Deno.test("probe source stays ASCII", () => {
  // Bun rewrites a non-ASCII character inside a template literal into a
  // \uXXXX escape, and inside String.raw that changes the value: the export
  // and the text the Rust hosts extract from the file stopped being equal
  // (6 em dashes made them differ by 30 characters). ASCII keeps them
  // byte-identical; a user-visible ellipsis is written as "\u2026".
  assert(!/[^\x00-\x7F]/.test(PROBE_SOURCE), "probe must be ASCII only");
});

Deno.test("Rust-style extraction from the file yields the exact export", () => {
  // The Rust hosts extract the probe from this same file (include_str! +
  // split on "String.raw`"). Mirror that algorithm here so a drift between
  // the two copies fails the Bun test suite.
  const fileText = Deno.readTextFileSync(
    new URL("./probe.js", import.meta.url),
  );
  const marker = "String.raw`";
  const start = fileText.indexOf(marker);
  assert(start >= 0, "probe.js must contain the String.raw export");
  const end = fileText.indexOf("`", start + marker.length);
  assert(end > start, "String.raw export must be closed by a backtick");
  const extracted = fileText.slice(start + marker.length, end);
  assertEquals(
    extracted,
    PROBE_SOURCE,
    "Rust extraction must equal the export",
  );
});

Deno.test("probe implements the required observation surface", () => {
  const needs = [
    "__lumiscaProbe",
    "consoleEntries",
    "unhandledrejection",
    "MutationObserver",
    "readyState",
    "aria-label",
    "aria-labelledby",
    "scrollIntoView",
    "requestSubmit",
    "input",
    "change",
    "WebSocket", // referenced only as the exclusion rule — never wrapped
    "ref_not_found",
  ];
  for (const needle of needs) {
    assert(PROBE_SOURCE.includes(needle), `probe must cover "${needle}"`);
  }
  // The probe must not be installed twice.
  assert(PROBE_SOURCE.includes("window.__lumiscaProbe) { return; }"));
});
