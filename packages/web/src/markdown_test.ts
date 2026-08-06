import { assertEquals } from "jsr:@std/assert";
import { renderMarkdown } from "./markdown.ts";

Deno.test("markdown renders headings, code and lists", () => {
  const html = renderMarkdown("# Title\n\n```ts\nconst x = 1;\n```\n\n- a\n- b");
  assertEquals(html.includes("<h1>Title</h1>"), true);
  assertEquals(html.includes("<code"), true);
  assertEquals(html.includes("const x = 1;"), true);
  assertEquals(html.includes("<li>a</li>"), true);
});

Deno.test("markdown escapes raw HTML from the model", () => {
  const html = renderMarkdown("hello <script>alert(1)</script> world");
  assertEquals(html.includes("<script>"), false);
  assertEquals(html.includes("&lt;script&gt;"), true);
});

Deno.test("markdown blocks javascript: links", () => {
  const html = renderMarkdown("[click](javascript:alert(1))");
  assertEquals(html.includes('href="javascript:'), false);
  assertEquals(html.includes('href="#"'), true);
});

Deno.test("markdown allows safe links", () => {
  const html = renderMarkdown("[pi](https://pi.dev)");
  assertEquals(html.includes('href="https://pi.dev"'), true);
});

Deno.test("markdown handles inline formatting", () => {
  const html = renderMarkdown("**bold** and `code` and ~~strike~~");
  assertEquals(html.includes("<strong>bold</strong>"), true);
  assertEquals(html.includes("<code>code</code>"), true);
});
