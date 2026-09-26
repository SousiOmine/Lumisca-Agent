import { assertEquals } from "@std/assert";
import {
  MAX_CONSOLE_ENTRIES,
  MAX_ELEMENT_NAME_CHARS,
  MAX_ELEMENT_TEXT_CHARS,
  MAX_ELEMENT_VALUE_CHARS,
  MAX_ENTRY_TEXT_CHARS,
  MAX_PAGE_ERRORS,
  MAX_PAGE_TEXT_CHARS,
  MAX_RPC_REQUEST_BYTES,
  MAX_RPC_RESPONSE_BYTES,
  MAX_SCREENSHOT_BYTES,
  MAX_SNAPSHOT_ELEMENTS,
  RPC_ACT,
  RPC_CLOSE,
  RPC_ERROR_ACTION_FAILED,
  RPC_ERROR_AUTH,
  RPC_ERROR_CLOSED,
  RPC_ERROR_INTERNAL,
  RPC_ERROR_INVALID,
  RPC_ERROR_NOT_OPEN,
  RPC_ERROR_PROBE_ERROR,
  RPC_ERROR_PROBE_MISSING,
  RPC_ERROR_REF_NOT_FOUND,
  RPC_ERROR_SCREENSHOT_UNSUPPORTED,
  RPC_ERROR_TIMEOUT,
  RPC_ERROR_TOO_LARGE,
  RPC_ERROR_WAIT_UNSUPPORTED,
  RPC_OBSERVE,
  RPC_OPEN,
  RPC_PATH,
  RPC_SCREENSHOT,
  RPC_TOKEN_HEADER,
  RPC_WAIT,
} from "./types.ts";

/**
 * The browser protocol constants are declared once, in `types.ts`, and
 * mirrored twice: the page probe (`probe.js`, in the injected string) and
 * the Rust host (`packages/browser-rpc/src/lib.rs`) each repeat the values
 * they enforce. Nothing else compares the three, and a drift is invisible
 * — a probe that keeps 300 elements while the tool layer promises a smaller
 * snapshot, or a host that answers a code the client no longer lists.
 *
 * These tests read the two mirrors as text and compare them to the
 * declarations above, which is how the other cross-artifact agreement in
 * this repository is kept (see server/update/verify_test.ts).
 */

const PROBE_URL = new URL("./probe.js", import.meta.url);
const RUST_LIB_URL = new URL(
  "../../browser-rpc/src/lib.rs",
  import.meta.url,
);

/** The `limits` module body of the Rust crate, or the whole file when the
 * module is missing (the comparison then fails with a useful message). */
function rustModule(source: string, name: string): string {
  const match = source.match(
    new RegExp(`pub mod ${name} \\{([\\s\\S]*?)\\n\\}`),
  );
  return match?.[1] ?? "";
}

/** Evaluate the `N * M * …` shape the Rust limits use. */
function rustUsize(expr: string): number {
  return expr.split("*").reduce(
    (value, part) => value * Number(part.trim()),
    1,
  );
}

Deno.test("probe.js mirrors the snapshot limits in types.ts", () => {
  const probe = Deno.readTextFileSync(PROBE_URL);
  const declared = new Map<string, number>();
  for (const match of probe.matchAll(/^\s*var (\w+) = (\d+);/gm)) {
    declared.set(match[1]!, Number(match[2]));
  }
  assertEquals(declared.size > 0, true, "probe.js declares no limits");

  const mirror: Record<string, number> = {
    MAX_ELEMENTS: MAX_SNAPSHOT_ELEMENTS,
    MAX_TEXT: MAX_PAGE_TEXT_CHARS,
    MAX_CONSOLE: MAX_CONSOLE_ENTRIES,
    MAX_ERRORS: MAX_PAGE_ERRORS,
    MAX_ENTRY: MAX_ENTRY_TEXT_CHARS,
    MAX_ELEMENT_TEXT: MAX_ELEMENT_TEXT_CHARS,
    MAX_ELEMENT_NAME: MAX_ELEMENT_NAME_CHARS,
    MAX_VALUE: MAX_ELEMENT_VALUE_CHARS,
  };
  for (const [name, value] of Object.entries(mirror)) {
    assertEquals(
      declared.get(name),
      value,
      `probe.js ${name} must match types.ts`,
    );
  }
});

Deno.test("the Rust host mirrors the RPC size limits in types.ts", () => {
  const limits = rustModule(
    Deno.readTextFileSync(RUST_LIB_URL),
    "limits",
  );
  const declared = new Map<string, number>();
  for (
    const match of limits.matchAll(
      /pub const (\w+): usize = ([0-9*\s]+);/g,
    )
  ) {
    declared.set(match[1]!, rustUsize(match[2]!));
  }
  assertEquals(declared.size > 0, true, "the limits module declares nothing");

  const mirror: Record<string, number> = {
    MAX_REQUEST_BYTES: MAX_RPC_REQUEST_BYTES,
    MAX_RESPONSE_BYTES: MAX_RPC_RESPONSE_BYTES,
    MAX_SCREENSHOT_BYTES,
  };
  for (const [name, value] of Object.entries(mirror)) {
    assertEquals(
      declared.get(name),
      value,
      `browser-rpc limits::${name} must match types.ts`,
    );
  }
});

Deno.test("the Rust host mirrors the RPC methods and error codes", () => {
  const source = Deno.readTextFileSync(RUST_LIB_URL);

  const methods = new Map<string, string>();
  for (
    const match of rustModule(source, "methods").matchAll(
      /pub const (\w+): &str = "([^"]*)";/g,
    )
  ) {
    methods.set(match[1]!, match[2]!);
  }
  assertEquals(
    [...methods.entries()].sort(),
    [
      ["ACT", RPC_ACT],
      ["CLOSE", RPC_CLOSE],
      ["OBSERVE", RPC_OBSERVE],
      ["OPEN", RPC_OPEN],
      ["SCREENSHOT", RPC_SCREENSHOT],
      ["WAIT", RPC_WAIT],
    ].sort(),
  );

  const codes = new Map<string, string>();
  for (
    const match of rustModule(source, "error_codes").matchAll(
      /pub const (\w+): &str = "([^"]*)";/g,
    )
  ) {
    codes.set(match[1]!, match[2]!);
  }
  assertEquals(
    [...codes.entries()].sort(),
    [
      ["ACTION_FAILED", RPC_ERROR_ACTION_FAILED],
      ["AUTH", RPC_ERROR_AUTH],
      ["CLOSED", RPC_ERROR_CLOSED],
      ["INTERNAL", RPC_ERROR_INTERNAL],
      ["INVALID", RPC_ERROR_INVALID],
      ["NOT_OPEN", RPC_ERROR_NOT_OPEN],
      ["PROBE_ERROR", RPC_ERROR_PROBE_ERROR],
      ["PROBE_MISSING", RPC_ERROR_PROBE_MISSING],
      ["REF_NOT_FOUND", RPC_ERROR_REF_NOT_FOUND],
      ["SCREENSHOT_UNSUPPORTED", RPC_ERROR_SCREENSHOT_UNSUPPORTED],
      ["TIMEOUT", RPC_ERROR_TIMEOUT],
      ["TOO_LARGE", RPC_ERROR_TOO_LARGE],
      ["WAIT_UNSUPPORTED", RPC_ERROR_WAIT_UNSUPPORTED],
    ].sort(),
  );

  assertEquals(
    source.includes(`pub const TOKEN_HEADER: &str = "${RPC_TOKEN_HEADER}"`),
    true,
  );
  assertEquals(
    source.includes(`pub const RPC_PATH: &str = "${RPC_PATH}"`),
    true,
  );
});
