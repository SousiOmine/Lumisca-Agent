import { assertEquals } from "@std/assert";
import { THEME_COLORS } from "@lumisca/core/shared";
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

function parse(
  theme: "light" | "dark",
  language: "ja" | "en" = "ja",
): ParsedManifest {
  return JSON.parse(renderManifest({ theme, language })) as ParsedManifest;
}

Deno.test("the manifest carries what Chromium requires to install", () => {
  const manifest = parse("dark");
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

Deno.test("every manifest icon is a file the build ships", () => {
  const names = (parse("dark").icons ?? []).map((icon) =>
    icon.src.replace("/pwa/", "")
  );
  for (const name of names) {
    assertEquals(PWA_ICON_FILES.includes(name), true, name);
  }
  // iOS reads its icon through the page's `<link>`, not the manifest, but it
  // is packaged and served with the others.
  assertEquals(PWA_ICON_FILES.includes("apple-touch-icon.png"), true);
});

Deno.test("theme_color is the canvas colour of the theme being served", () => {
  for (const theme of ["dark", "light"] as const) {
    const manifest = parse(theme);
    assertEquals(manifest.theme_color, THEME_COLORS[theme], theme);
    // The splash screen starts at the same colour: anything else flashes a
    // rectangle the app never shows before its first paint.
    assertEquals(manifest.background_color, THEME_COLORS[theme], theme);
  }
});

Deno.test("the manifest speaks the app language", () => {
  assertEquals(parse("dark", "ja").lang, "ja");
  assertEquals(parse("dark", "en").lang, "en");
  // The description is user-facing text, so it comes from the catalogue.
  const ja = parse("dark", "ja").description;
  const en = parse("dark", "en").description;
  assertEquals(typeof ja, "string");
  assertEquals(typeof en, "string");
  assertEquals(ja === en, false);
});
