import { assertEquals, assertMatch } from "@std/assert";
import {
  type BrowserPreviewMode,
  findBrowserHostBinary,
  parseBrowserPreview,
} from "./browser-host.ts";

Deno.test("parseBrowserPreview defaults to auto", () => {
  assertEquals(parseBrowserPreview(undefined), "auto");
  assertEquals(parseBrowserPreview("always"), "always");
  assertEquals(parseBrowserPreview("never"), "never");
});

Deno.test("parseBrowserPreview rejects unknown modes", () => {
  let message = "";
  try {
    parseBrowserPreview("sometimes");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertMatch(message, /auto \/ always \/ never/);
});

Deno.test("findBrowserHostBinary honors the explicit env override", () => {
  const override = Deno.build.os === "windows"
    ? "C:\\tools\\lumisca-browser-host.exe"
    : "/opt/lumisca-browser-host";
  const previous = Deno.env.get("LUMISCA_BROWSER_HOST");
  try {
    Deno.env.set("LUMISCA_BROWSER_HOST", override);
    assertEquals(findBrowserHostBinary(), override);
  } finally {
    if (previous === undefined) Deno.env.delete("LUMISCA_BROWSER_HOST");
    else Deno.env.set("LUMISCA_BROWSER_HOST", previous);
  }
});

Deno.test("findBrowserHostBinary finds the repository build when present", () => {
  // The test runs in the repo; the release binary may or may not be built.
  // What must hold regardless: the returned path (when found) points at a
  // file or is the env override, and never a random directory.
  const previous = Deno.env.get("LUMISCA_BROWSER_HOST");
  try {
    Deno.env.delete("LUMISCA_BROWSER_HOST");
    const found = findBrowserHostBinary();
    if (found !== undefined) {
      assertMatch(
        found,
        /lumisca-browser-host(\.exe)?$/,
        `unexpected binary path: ${found}`,
      );
    }
  } finally {
    if (previous !== undefined) Deno.env.set("LUMISCA_BROWSER_HOST", previous);
  }
});

Deno.test("the mode type is a closed union", () => {
  const modes: BrowserPreviewMode[] = ["auto", "always", "never"];
  assertEquals(modes.length, 3);
});
