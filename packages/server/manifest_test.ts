import { test } from "bun:test";
import { THEME_COLORS } from "@lumisca/core/shared";
import { assertEquals } from "@std/assert";
import { PWA_ICON_FILES, renderManifest } from "./manifest.ts";

/** The fields this module is responsible for. The manifest is plain JSON;
 * reading it back is what the browser does. */
interface ParsedManifest {
  id?: string;
  name?: string;
  short_name?: string;
  description?: string;
  lang?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  theme_color?: string;
  background_color?: string;
  icons?: { src: string; sizes: string; type: string; purpose?: string }[];
  prefer_related_applications?: boolean;
}

function parse(language: "ja" | "en" = "ja"): ParsedManifest {
  return JSON.parse(renderManifest({ language })) as ParsedManifest;
}

test("the manifest carries what Chromium requires to install", () => {
  const manifest = parse();
  assertEquals(manifest.id, "/");
  assertEquals(manifest.name, "Lumisca Agent");
  assertEquals(manifest.short_name, "Lumisca");
  assertEquals(manifest.start_url, "/");
  assertEquals(manifest.scope, "/");
  assertEquals(manifest.display, "standalone");
  assertEquals(manifest.prefer_related_applications, false);
  // 192 and 512 in both roles: Chromium's installability check asks for
  // both sizes, and Android crops the maskable one.
  const icons = manifest.icons ?? [];
  assertEquals(
    icons.map((icon) => `${icon.src} ${icon.sizes} ${icon.purpose}`),
    [
      "/pwa/icon-192.png 192x192 any",
      "/pwa/icon-512.png 512x512 any",
      "/pwa/icon-maskable-512.png 512x512 maskable",
    ],
  );
  for (const icon of icons) assertEquals(icon.type, "image/png");
});

test("every manifest icon is a file the build ships", () => {
  const names = (parse().icons ?? []).map((icon) =>
    icon.src.replace("/pwa/", ""),
  );
  for (const name of names) {
    assertEquals(PWA_ICON_FILES.includes(name), true, name);
  }
  // iOS reads its icon through the page's `<link>`, not the manifest, but it
  // is packaged and served with the others.
  assertEquals(PWA_ICON_FILES.includes("apple-touch-icon.png"), true);
});

test("theme_color is the app's light canvas", () => {
  // The theme is this client's choice and a manifest cannot vary by client,
  // so both colours stay on the canvas the app is designed around. The page
  // corrects its own theme-color meta after the first paint.
  const manifest = parse();
  assertEquals(manifest.theme_color, THEME_COLORS.light);
  // The splash screen starts at the same colour: anything else flashes a
  // rectangle the app never shows before its first paint.
  assertEquals(manifest.background_color, THEME_COLORS.light);
});

test("the manifest speaks the app language", () => {
  assertEquals(parse("ja").lang, "ja");
  assertEquals(parse("en").lang, "en");
  // The description is user-facing text, so it comes from the catalogue.
  const ja = parse("ja").description;
  const en = parse("en").description;
  assertEquals(typeof ja, "string");
  assertEquals(typeof en, "string");
  assertEquals(ja === en, false);
});
