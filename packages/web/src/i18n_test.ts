import { createTranslator } from "@lumisca/core/shared";
import { assertEquals } from "@std/assert";
import { ApiError } from "./api-client.ts";
import { describeError } from "./i18n.ts";

/**
 * The failure line the UI shows. It is the one place the reader is told what
 * went wrong, so what it says has to depend on what actually happened: a
 * dropped connection, a rejected request and an unreadable reply are three
 * different situations, and before this they were all the transport's raw
 * text ("Failed to fetch", "Request failed: 503") in no language at all.
 */
const ja = createTranslator("ja");
const en = createTranslator("en");

Deno.test("describeError: each failure kind is said in the app's language", () => {
  assertEquals(
    describeError(new ApiError("Failed to fetch", "network"), ja),
    "サーバーに接続できません。自動で再試行します。",
  );
  assertEquals(
    describeError(new ApiError("Request failed: 400", "http-4xx"), en),
    "The request was rejected",
  );
  assertEquals(
    describeError(new ApiError("Request failed: 503", "http-5xx"), ja),
    "サーバー側でエラーが起きました",
  );
  assertEquals(
    describeError(new ApiError("Unexpected token <", "parse"), en),
    "The server's reply could not be read",
  );
});

Deno.test("describeError: the server's own text follows as the detail", () => {
  // The sentence says retrying will not help; the detail says what to fix.
  const error = new ApiError("provider not configured", "http-4xx", {
    status: 400,
    detail: "provider not configured",
  });
  assertEquals(
    describeError(error, ja),
    "入力が受け付けられませんでした: 詳細: provider not configured",
  );
  // A 5xx with no body (a proxy answering HTML) carries no detail, so the
  // line is the sentence alone — never the word "null".
  assertEquals(
    describeError(new ApiError("Request failed: 502", "http-5xx"), en),
    "The server failed to handle the request",
  );
});

Deno.test("describeError: a failure that is not a request keeps its message", () => {
  // Everything else (a bug, a client-side validation error, the machine
  // refusing a stella action) has no classification, and its message is
  // already the explanation the code that threw it wrote.
  assertEquals(
    describeError(new Error("No stella conversation"), ja),
    "No stella conversation",
  );
  assertEquals(describeError("plain string", en), "plain string");
  assertEquals(
    describeError({ message: "from a plain object" }, ja),
    "from a plain object",
  );
});
