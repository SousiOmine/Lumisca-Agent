import { test } from "bun:test";
import type { PromptFileRef } from "@lumisca/core/shared";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import { PromptAttachments } from "./PromptAttachments.tsx";

const BASE = "/api/stella/conversations/a1/upload";

function file(overrides: Partial<PromptFileRef> = {}): PromptFileRef {
  return {
    name: "report.pdf",
    path: "/home/agent/agents/a1/uploads/1-ab/01-report.pdf",
    size: 1229,
    ref: "uploads/1-ab/01-report.pdf",
    image: false,
    ...overrides,
  };
}

function render(files: readonly PromptFileRef[]): string {
  initLocale("ja");
  return renderToString(
    createElement(PromptAttachments, { files, base: BASE }),
  );
}

test("PromptAttachments: a prompt with nothing attached draws nothing", () => {
  assertEquals(render([]), "");
});

test("PromptAttachments: one picture is a single tile", () => {
  const html = render([
    file({ name: "shot.png", ref: "uploads/1-ab/01-shot.png", image: true }),
  ]);
  assertStringIncludes(html, "msg-attachment-images single");
  assertStringIncludes(html, "msg-attachment-image-button");
  // The grid draws the downscaled copy; the original is what a click opens.
  assertStringIncludes(html, "?ref=uploads%2F1-ab%2F01-shot.png");
  assertEquals(html.includes("preview=0"), false);
});

test("PromptAttachments: several pictures tile without the single modifier", () => {
  const html = render([
    file({ name: "one.png", ref: "uploads/1-ab/01-one.png", image: true }),
    file({ name: "two.jpg", ref: "uploads/1-ab/02-two.jpg", image: true }),
  ]);
  assertStringIncludes(html, "msg-attachment-images");
  assertEquals(html.includes("msg-attachment-images single"), false);
  assertEquals(html.includes("msg-attachment-image-button"), true);
});

test("PromptAttachments: a file is a card that names, sizes and downloads it", () => {
  const html = render([file()]);
  assertStringIncludes(html, "msg-attachment-files");
  assertStringIncludes(html, "msg-attachment-file-icon");
  assertStringIncludes(html, "report.pdf");
  assertStringIncludes(html, "1.2 KB");
  assertStringIncludes(html, 'download="report.pdf"');
  assertStringIncludes(html, "ダウンロード");
});
